import { createHash } from "node:crypto";
import type { PageDetails } from "@/lib/db/schema";
import { friendlyFetchError } from "../messages";
import { canonicalHost, normalizeUrl, urlsEquivalent } from "../url";
import { CHECKS, CHECKS_BY_KEY, DEALER_SCHEMA_TYPES, THIN_CONTENT_PAGE_TYPES, THRESHOLDS, type Category, type Severity } from "./config";

/**
 * Deterministic evaluation of a completed crawl.
 *
 * Pure function of the stored crawl data (pages, links, site-level facts):
 * the same inputs always produce the same issues and check results, which
 * is what makes the score reproducible. No network, no clock, no AI.
 */

export interface EvalPage {
  id: number;
  url: string;
  finalUrl: string | null;
  status: "pending" | "fetched" | "failed" | "skipped";
  pageType: string | null;
  isImportant: boolean;
  httpStatus: number | null;
  responseTimeMs: number | null;
  htmlBytes: number | null;
  title: string | null;
  metaDescription: string | null;
  h1: string[] | null;
  h2: string[] | null;
  canonical: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  lang: string | null;
  hasViewport: boolean | null;
  wordCount: number | null;
  internalLinksCount: number | null;
  imagesCount: number | null;
  imagesMissingAlt: number | null;
  blockingScriptsCount: number | null;
  schemaTypes: string[] | null;
  schemaErrors: number | null;
  openGraph: Record<string, string> | null;
  errorCode: string | null;
  details: PageDetails | null;
}

export interface EvalLink {
  url: string;
  isInternal: boolean;
  httpStatus: number | null;
  errorCode: string | null;
  isBroken: boolean;
  foundOn: string[];
  occurrences: number;
  anchorText: string | null;
}

export interface EvalSite {
  baseUrl: string;
  siteAvailable: boolean;
  homepageStatus: number | null;
  homepageErrorCode: string | null;
  /** checked=false: the robots.txt request was refused by bot protection, so its state is unknown. */
  robots: { found: boolean; blocksAll: boolean; blocksGooglebot: boolean; sitemaps: string[]; checked?: boolean };
  /** null = not checked (e.g. the scanner was blocked before fetching it). */
  sitemap: { found: boolean; urlCount: number } | null;
  importantPages: Array<{ key: string; label: string; found: boolean; url: string | null }>;
}

export interface IssueDraft {
  checkKey: string;
  category: Category;
  severity: Severity;
  url: string;
  pageId: number | null;
  message: string;
  recommendation: string;
  details?: Record<string, unknown>;
  fingerprint: string;
}

export interface CheckResult {
  checkKey: string;
  category: Category;
  label: string;
  severity: Severity;
  scope: "page" | "site";
  applicable: number;
  affected: number;
  /** For site checks with partial failure (e.g. 2 of 8 key pages missing). */
  siteRatio?: number;
}

export interface EvalResult {
  issues: IssueDraft[];
  checks: CheckResult[];
}

/** Scheme/www/trailing-slash-insensitive key used in fingerprints. */
export function urlKey(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
    return `${canonicalHost(u.hostname)}${path}${u.search}`;
  } catch {
    return url;
  }
}

function linkSubject(url: string): string {
  try {
    return normalizeUrl(url);
  } catch {
    return url;
  }
}

export function fingerprint(checkKey: string, url: string, subject?: string): string {
  return createHash("sha256")
    .update(`${checkKey}|${urlKey(url)}|${subject ?? ""}`)
    .digest("hex")
    .slice(0, 40);
}

const NETWORK_FAILURES = new Set(["TIMEOUT", "DNS", "CONNECTION", "TLS", "TOO_MANY_REDIRECTS", "UNKNOWN"]);
const IGNORED_FAILURES = new Set(["UNSAFE_URL", "NOT_HTML", "REDIRECT_OFFSITE", "ROBOTS_BLOCKED", "BLOCKED", "DUPLICATE", "NOT_EVALUATED"]);

function hasNoindex(p: EvalPage): boolean {
  return /noindex/i.test(p.robotsMeta ?? "") || /noindex/i.test(p.xRobotsTag ?? "");
}

export function isOkHtmlPage(p: EvalPage): boolean {
  return p.status === "fetched" && p.httpStatus !== null && p.httpStatus >= 200 && p.httpStatus < 300;
}

function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url;
  }
}

export function evaluateScan(pages: EvalPage[], links: EvalLink[], site: EvalSite): EvalResult {
  const issues: IssueDraft[] = [];
  const state = new Map<string, { applicable: number; affected: Set<string>; siteRatio?: number; issueCount: number }>();
  for (const c of CHECKS) state.set(c.key, { applicable: 0, affected: new Set(), issueCount: 0 });

  const applicable = (key: string, n = 1) => {
    state.get(key)!.applicable += n;
  };
  const flag = (key: string, page: { url: string; id: number | null }, message: string, details?: Record<string, unknown>, subject?: string, affectedKeys?: string[]) => {
    const def = CHECKS_BY_KEY[key];
    const st = state.get(key)!;
    for (const k of affectedKeys ?? [page.url]) st.affected.add(k);
    if (st.issueCount >= THRESHOLDS.maxIssuesPerCheck) return;
    st.issueCount++;
    issues.push({
      checkKey: key,
      category: def.category,
      severity: def.severity,
      url: page.url,
      pageId: page.id,
      message,
      recommendation: def.recommendation,
      details,
      fingerprint: fingerprint(key, page.url, subject),
    });
  };
  const siteRef = { url: site.baseUrl, id: null };

  /* ── Availability ── */
  applicable("site_unavailable");
  if (!site.siteAvailable) {
    flag("site_unavailable", siteRef, `The website could not be loaded during the scan. ${friendlyFetchError(site.homepageErrorCode, site.homepageStatus)}`, {
      httpStatus: site.homepageStatus,
      errorCode: site.homepageErrorCode,
    });
  }

  /* ── Crawlability (site level; evaluated even when the homepage is down) ── */
  const robotsKnown = site.robots.checked !== false;
  if (robotsKnown) applicable("robots_missing");
  if (robotsKnown && !site.robots.found) flag("robots_missing", { url: new URL("/robots.txt", site.baseUrl).toString(), id: null }, "No robots.txt file was found at the site root.");
  applicable("robots_blocks_all");
  if (site.robots.found && (site.robots.blocksAll || site.robots.blocksGooglebot)) {
    flag("robots_blocks_all", { url: new URL("/robots.txt", site.baseUrl).toString(), id: null }, site.robots.blocksAll ? "robots.txt blocks all crawlers from the homepage." : "robots.txt blocks Googlebot from the homepage.");
  }
  if (site.robots.found) {
    applicable("sitemap_not_in_robots");
    if (site.robots.sitemaps.length === 0) flag("sitemap_not_in_robots", { url: new URL("/robots.txt", site.baseUrl).toString(), id: null }, "robots.txt does not reference an XML sitemap.");
  }
  if (site.sitemap) applicable("sitemap_missing");
  if (site.sitemap && !site.sitemap.found) flag("sitemap_missing", { url: new URL("/sitemap.xml", site.baseUrl).toString(), id: null }, "No XML sitemap could be found (checked robots.txt, /sitemap.xml and /sitemap_index.xml).");
  if (site.sitemap?.found) {
    applicable("sitemap_empty");
    if (site.sitemap.urlCount === 0) flag("sitemap_empty", siteRef, "The XML sitemap does not list any URLs from this website.");
  }

  if (!site.siteAvailable) return finish();

  /* ── Page-level checks ── */
  const ok = pages.filter(isOkHtmlPage);
  const home = ok.find((p) => p.pageType === "home") ?? null;

  for (const p of pages) {
    if (p.status === "pending" || p.status === "skipped") continue;
    if (p.errorCode && IGNORED_FAILURES.has(p.errorCode)) continue;
    applicable("http_error");
    const serverError = p.httpStatus !== null && p.httpStatus >= 500;
    const networkFail = p.httpStatus === null && p.errorCode !== null && NETWORK_FAILURES.has(p.errorCode);
    const importantClientError = p.isImportant && p.httpStatus !== null && p.httpStatus >= 400 && p.httpStatus < 500;
    if (serverError || networkFail || importantClientError) {
      flag("http_error", p, friendlyFetchError(p.errorCode, p.httpStatus), { httpStatus: p.httpStatus, errorCode: p.errorCode });
    }
  }

  for (const p of ok) {
    const url = p.finalUrl ?? p.url;
    const d = p.details ?? {};

    applicable("not_https");
    if (url.startsWith("http:")) flag("not_https", p, "This page is served over an insecure HTTP connection.");
    if (url.startsWith("https:")) {
      applicable("mixed_content");
      if ((d.mixedContentCount ?? 0) > 0) flag("mixed_content", p, `${d.mixedContentCount} resource(s) are loaded over insecure HTTP on this HTTPS page.`, { count: d.mixedContentCount });
    }
    applicable("viewport_missing");
    if (!p.hasViewport) flag("viewport_missing", p, "The page has no mobile viewport meta tag.");
    applicable("lang_missing");
    if (!p.lang) flag("lang_missing", p, "The page does not declare its language.");
    if (p.responseTimeMs !== null) {
      applicable("slow_response");
      if (p.responseTimeMs > THRESHOLDS.slowResponseMs) flag("slow_response", p, `The page took ${(p.responseTimeMs / 1000).toFixed(1)}s to download.`, { responseTimeMs: p.responseTimeMs });
    }
    if (p.htmlBytes !== null) {
      applicable("large_html");
      if (p.htmlBytes > THRESHOLDS.largeHtmlBytes || d.truncated) flag("large_html", p, `The HTML document is ${(p.htmlBytes / 1024 / 1024).toFixed(1)} MB.`, { bytes: p.htmlBytes });
    }
    applicable("client_redirect");
    if (d.clientRedirect)
      flag("client_redirect", p, `The page uses a ${d.clientRedirect.type === "meta" ? "meta-refresh" : "JavaScript"} redirect to ${d.clientRedirect.target}.`, { target: d.clientRedirect.target, type: d.clientRedirect.type });
    applicable("blocking_scripts");
    if ((p.blockingScriptsCount ?? 0) > THRESHOLDS.blockingScriptsMax)
      flag("blocking_scripts", p, `${p.blockingScriptsCount} render-blocking scripts are loaded in the page head.`, { count: p.blockingScriptsCount });

    // Metadata
    applicable("title_missing");
    if (!p.title) flag("title_missing", p, "The page is missing a title tag.");
    else {
      applicable("title_length");
      const len = p.title.length;
      if (len < THRESHOLDS.titleMin) flag("title_length", p, `The title is too short (${len} characters).`, { length: len, title: p.title });
      else if (len > THRESHOLDS.titleMax) flag("title_length", p, `The title is too long (${len} characters) and may be truncated in search results.`, { length: len, title: p.title });
    }
    applicable("description_missing");
    if (!p.metaDescription) flag("description_missing", p, "The page is missing a meta description.");
    else {
      applicable("description_length");
      const len = p.metaDescription.length;
      if (len < THRESHOLDS.descriptionMin) flag("description_length", p, `The meta description is too short (${len} characters).`, { length: len });
      else if (len > THRESHOLDS.descriptionMax) flag("description_length", p, `The meta description is too long (${len} characters).`, { length: len });
    }
    applicable("canonical_missing");
    if (!p.canonical) flag("canonical_missing", p, "The page has no canonical tag.");
    else {
      applicable("canonical_mismatch");
      const hasQuery = url.includes("?");
      const matches = urlsEquivalent(p.canonical, url) || (hasQuery && urlsEquivalent(p.canonical, stripQuery(url)));
      if (!matches) flag("canonical_mismatch", p, `The canonical URL points to a different page: ${p.canonical}`, { canonical: p.canonical });
    }
    applicable("og_missing");
    const og = p.openGraph ?? {};
    const missingOg = ["og:title", "og:description", "og:image"].filter((k) => !og[k]);
    if (missingOg.length) flag("og_missing", p, `Missing Open Graph tags: ${missingOg.join(", ")}.`, { missing: missingOg });

    // Content structure
    const h1 = p.h1 ?? [];
    applicable("h1_missing");
    if (h1.length === 0) flag("h1_missing", p, "The page has no H1 heading.");
    else {
      applicable("h1_multiple");
      if (h1.length > 1) flag("h1_multiple", p, `The page has ${h1.length} H1 headings.`, { headings: h1.slice(0, 5) });
    }
    if ((p.wordCount ?? 0) > THRESHOLDS.h2RequiredAboveWords) {
      applicable("h2_missing");
      if ((p.h2 ?? []).length === 0) flag("h2_missing", p, `The page has ${p.wordCount} words but no H2 subheadings.`);
    }
    if (p.pageType && THIN_CONTENT_PAGE_TYPES.includes(p.pageType)) {
      applicable("thin_content");
      if ((p.wordCount ?? 0) < THRESHOLDS.thinContentWords) flag("thin_content", p, `Only ${p.wordCount ?? 0} words of visible text on this key page.`, { wordCount: p.wordCount });
    }

    // Links
    applicable("broken_internal_link");
    applicable("broken_external_link");
    applicable("low_internal_links");
    if ((p.internalLinksCount ?? 0) < THRESHOLDS.lowInternalLinks) flag("low_internal_links", p, `The page links to only ${p.internalLinksCount ?? 0} internal page(s).`);

    // Images
    if ((p.imagesCount ?? 0) > 0) {
      applicable("image_alt_missing");
      if ((p.imagesMissingAlt ?? 0) > 0)
        flag("image_alt_missing", p, `${p.imagesMissingAlt} of ${p.imagesCount} images are missing alt text.`, { missing: p.imagesMissingAlt, total: p.imagesCount, samples: d.imagesMissingAltSamples ?? [] });
      applicable("image_dimensions_missing");
      const noDims = d.imagesWithoutDimensions ?? 0;
      if (noDims / (p.imagesCount ?? 1) > 0.5) flag("image_dimensions_missing", p, `${noDims} of ${p.imagesCount} images have no width/height attributes.`, { count: noDims });
    }

    // Structured data
    applicable("schema_missing");
    if ((p.schemaTypes ?? []).length === 0) flag("schema_missing", p, "No structured data (JSON-LD or microdata) was found on this page.");
    applicable("schema_invalid");
    if ((p.schemaErrors ?? 0) > 0) flag("schema_invalid", p, `${p.schemaErrors} JSON-LD block(s) could not be parsed.`, { errors: p.schemaErrors });

    // Indexability
    const isKey = p.isImportant || p.pageType === "home";
    applicable(isKey ? "noindex_important" : "noindex_page");
    if (hasNoindex(p)) {
      flag(isKey ? "noindex_important" : "noindex_page", p, `This page is marked "noindex" (${[p.robotsMeta, p.xRobotsTag].filter(Boolean).join("; ")}) and will not appear in search results.`);
    }
  }

  // Duplicates (only among indexable pages — noindex duplicates don't compete)
  const dupCheck = (key: "title_duplicate" | "description_duplicate", get: (p: EvalPage) => string | null, label: string) => {
    const groups = new Map<string, EvalPage[]>();
    for (const p of ok) {
      const v = get(p)?.trim().toLowerCase();
      if (!v || hasNoindex(p)) continue;
      applicable(key);
      const g = groups.get(v) ?? [];
      g.push(p);
      groups.set(v, g);
    }
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      for (const p of g) {
        const others = g.filter((o) => o !== p).map((o) => o.url);
        flag(key, p, `This ${label} is shared with ${others.length} other page(s).`, { value: get(p), otherUrls: others.slice(0, 5) });
      }
    }
  };
  dupCheck("title_duplicate", (p) => p.title, "title");
  dupCheck("description_duplicate", (p) => p.metaDescription, "meta description");

  // Broken links — one issue per broken target, attached to the first page it was found on.
  const sortedLinks = [...links].filter((l) => l.isBroken).sort((a, b) => b.occurrences - a.occurrences || (a.url < b.url ? -1 : 1));
  for (const l of sortedLinks) {
    const key = l.isInternal ? "broken_internal_link" : "broken_external_link";
    const foundOn = [...l.foundOn].sort();
    const source = foundOn[0];
    if (!source) continue;
    const page = ok.find((p) => p.url === source || p.finalUrl === source);
    const st = state.get(key)!;
    // Nav links broken site-wide: occurrences approximates how many pages carry the link.
    const approxPages = Math.max(foundOn.length, Math.min(l.occurrences, st.applicable));
    const affectedKeys = foundOn.length >= approxPages ? foundOn : [...foundOn, ...Array.from({ length: approxPages - foundOn.length }, (_, i) => `${l.url}#occ${i}`)];
    flag(
      key,
      { url: source, id: page?.id ?? null },
      `Broken link to ${l.url} — ${friendlyFetchError(l.errorCode, l.httpStatus)}${l.occurrences > 1 ? ` Found on ${l.occurrences} pages.` : ""}`,
      { target: l.url, httpStatus: l.httpStatus, errorCode: l.errorCode, foundOn: foundOn.slice(0, 5), occurrences: l.occurrences, anchorText: l.anchorText },
      // The slash-insensitive form keeps the issue's identity stable across scans however the site writes the link.
      linkSubject(l.url),
      affectedKeys,
    );
  }

  /* ── Site-level checks needing the homepage ── */
  if (home) {
    applicable("dealer_schema_missing");
    const types = home.schemaTypes ?? [];
    if (!types.some((t) => DEALER_SCHEMA_TYPES.includes(t)))
      flag("dealer_schema_missing", home, `The homepage has no dealership/business schema${types.length ? ` (found: ${types.slice(0, 5).join(", ")})` : ""}.`, { found: types });
  }
  applicable("important_page_missing");
  const missing = site.importantPages.filter((p) => !p.found);
  for (const m of missing) {
    flag("important_page_missing", siteRef, `No "${m.label}" page could be found or linked from the site navigation.`, { page: m.key }, m.key);
  }
  if (site.importantPages.length) state.get("important_page_missing")!.siteRatio = missing.length / site.importantPages.length;

  return finish();

  function finish(): EvalResult {
    const checks: CheckResult[] = CHECKS.map((c) => {
      const st = state.get(c.key)!;
      return {
        checkKey: c.key,
        category: c.category,
        label: c.label,
        severity: c.severity,
        scope: c.scope,
        applicable: st.applicable,
        affected: st.affected.size,
        siteRatio: st.siteRatio,
      };
    });
    issues.sort((a, b) => (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
    return { issues, checks };
  }
}
