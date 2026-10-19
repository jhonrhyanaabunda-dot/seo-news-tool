import * as cheerio from "cheerio";
import { cleanText } from "@/lib/security/sanitize";
import { resolveHref, isSameSite, normalizeUrl } from "./url";

/** Hosts that serve conversion/analytics beacons rather than images a visitor sees. */
const TRACKING_PIXEL_HOSTS =
  /(^|\.)(facebook\.com|facebook\.net|arttrk\.com|xad\.com|crwdcntrl\.net|doubleclick\.net|google-analytics\.com|googleadservices\.com|googlesyndication\.com|bat\.bing\.com|analytics\.twitter\.com|ads-twitter\.com|t\.co|px\.ads\.linkedin\.com|ct\.pinterest\.com|adsrvr\.org|quantserve\.com|scorecardresearch\.com|demdex\.net|everesttech\.net|adnxs\.com|taboola\.com|outbrain\.com|tiktok\.com|snapchat\.com|clarity\.ms)$/i;

/**
 * True for an <img> that exists only to fire a tracking request: a known beacon
 * host, a 0–1px image, or one that is never displayed. Such images have no
 * meaning to a reader, so alt text and dimensions do not apply to them.
 */
export function isTrackingPixel(img: { src: string; width?: string; height?: string; style?: string; hidden?: boolean }): boolean {
  if (img.hidden) return true;
  if (img.style && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(img.style)) return true;
  const w = img.width === undefined ? NaN : Number.parseFloat(img.width);
  const h = img.height === undefined ? NaN : Number.parseFloat(img.height);
  if (w <= 1 && h <= 1) return true;
  try {
    return TRACKING_PIXEL_HOSTS.test(new URL(img.src, "https://placeholder.invalid/").hostname);
  } catch {
    return false;
  }
}

export interface ExtractedLink {
  url: string;
  normalized: string;
  isInternal: boolean;
  anchor: string;
  nofollow: boolean;
}

export interface PageData {
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  h2: string[];
  canonical: string | null;
  robotsMeta: string | null;
  lang: string | null;
  hasViewport: boolean;
  wordCount: number;
  links: ExtractedLink[];
  internalLinksCount: number;
  externalLinksCount: number;
  imagesCount: number;
  imagesMissingAlt: number;
  imagesMissingAltSamples: string[];
  imagesWithoutDimensions: number;
  scriptsCount: number;
  blockingScriptsCount: number;
  stylesheetsCount: number;
  mixedContentCount: number;
  schemaTypes: string[];
  schemaErrors: number;
  openGraph: Record<string, string>;
  twitterCard: boolean;
  /** Target of a meta-refresh or script-only redirect (search engines handle these poorly). */
  clientRedirect: { type: "meta" | "script"; target: string } | null;
}

const MAX_LINKS_PER_PAGE = 400;
const MAX_EXTERNAL_LINKS_PER_PAGE = 60;

function collectSchemaTypes(node: unknown, out: Set<string>, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) collectSchemaTypes(n, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") out.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.add(x);
    if (obj["@graph"]) collectSchemaTypes(obj["@graph"], out, depth + 1);
    for (const k of ["mainEntity", "itemListElement", "hasOfferCatalog", "department", "subOrganization"]) {
      if (obj[k]) collectSchemaTypes(obj[k], out, depth + 1);
    }
  }
}

/** Extract everything the checks need from an HTML document. Pure function. */
export function parsePage(html: string, pageUrl: string): PageData {
  const $ = cheerio.load(html);
  const base = $("base[href]").attr("href");
  const resolvedBase = base ? (resolveHref(base, pageUrl)?.toString() ?? pageUrl) : pageUrl;
  const page = new URL(pageUrl);

  const metaByName = (name: string) => {
    let val: string | undefined;
    $("meta[name]").each((_, el) => {
      if (val === undefined && ($(el).attr("name") ?? "").trim().toLowerCase() === name) val = $(el).attr("content");
    });
    return val;
  };

  const title = cleanText($("head > title").first().text() || $("title").first().text(), 500) || null;
  const metaDescription = cleanText(metaByName("description"), 1000) || null;
  const h1 = $("h1")
    .map((_, el) => cleanText($(el).text(), 300))
    .get()
    .filter(Boolean)
    .slice(0, 20);
  const h2 = $("h2")
    .map((_, el) => cleanText($(el).text(), 300))
    .get()
    .filter(Boolean)
    .slice(0, 40);

  let canonical: string | null = null;
  $("link[rel]").each((_, el) => {
    if (canonical === null && ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
      const href = $(el).attr("href");
      const r = href ? resolveHref(href, resolvedBase) : null;
      canonical = r ? r.toString() : href?.trim() || null;
    }
  });

  const robotsParts = [metaByName("robots"), metaByName("googlebot")].filter(Boolean) as string[];
  const robotsMeta = robotsParts.length ? cleanText(robotsParts.join(", "), 200) : null;
  const lang = cleanText($("html").attr("lang"), 20) || null;
  const hasViewport = Boolean(metaByName("viewport"));

  // Word count of visible text (scripts, styles, templates and nav chrome removed).
  const $body = $("body").clone();
  $body.find("script, style, noscript, template, svg, iframe").remove();
  const text = cleanText($body.text(), 400_000);
  const wordCount = text ? text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length : 0;

  // Links
  const seen = new Map<string, ExtractedLink>();
  let external = 0;
  $("a[href]").each((_, el) => {
    if (seen.size >= MAX_LINKS_PER_PAGE) return false;
    const href = $(el).attr("href") ?? "";
    const resolved = resolveHref(href, resolvedBase);
    if (!resolved) return;
    let normalized: string;
    try {
      normalized = normalizeUrl(resolved);
    } catch {
      return;
    }
    if (seen.has(normalized)) return;
    const isInternal = isSameSite(page, resolved);
    if (!isInternal) {
      if (external >= MAX_EXTERNAL_LINKS_PER_PAGE) return;
      external++;
    }
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    seen.set(normalized, {
      url: resolved.toString(),
      normalized,
      isInternal,
      anchor: cleanText($(el).text() || $(el).attr("aria-label") || $(el).attr("title") || $(el).find("img").attr("alt"), 200),
      nofollow: rel.split(/\s+/).includes("nofollow"),
    });
  });
  const links = [...seen.values()];

  // Images
  let imagesCount = 0;
  let imagesMissingAlt = 0;
  let imagesWithoutDimensions = 0;
  const imagesMissingAltSamples: string[] = [];
  $("img").each((_, el) => {
    const $img = $(el);
    if ($img.attr("role") === "presentation" || $img.attr("aria-hidden") === "true") return;
    const src = $img.attr("src") ?? $img.attr("data-src") ?? "";
    if (/^data:/i.test(src)) return;
    // Ad/analytics beacons are injected as <img> but are not content: counting them
    // flagged "missing alt text" on every page of sites whose real images were fine.
    if (isTrackingPixel({ src, width: $img.attr("width"), height: $img.attr("height"), style: $img.attr("style"), hidden: $img.attr("hidden") !== undefined })) return;
    imagesCount++;
    if ($img.attr("alt") === undefined) {
      imagesMissingAlt++;
      if (imagesMissingAltSamples.length < 5) imagesMissingAltSamples.push(cleanText(src, 300) || "(inline image)");
    }
    if (!$img.attr("width") || !$img.attr("height")) imagesWithoutDimensions++;
  });

  // Scripts / styles / mixed content (performance indicators)
  let scriptsCount = 0;
  let blockingScriptsCount = 0;
  $("script[src]").each((_, el) => {
    scriptsCount++;
    const $s = $(el);
    const inHead = $s.parents("head").length > 0;
    if (inHead && $s.attr("async") === undefined && $s.attr("defer") === undefined && $s.attr("type") !== "module") blockingScriptsCount++;
  });
  const stylesheetsCount = $('link[rel~="stylesheet"]').length;
  let mixedContentCount = 0;
  if (page.protocol === "https:") {
    $('img[src^="http://"], script[src^="http://"], link[rel~="stylesheet"][href^="http://"], iframe[src^="http://"], video[src^="http://"], source[src^="http://"]').each(() => {
      mixedContentCount++;
    });
  }

  // Structured data
  const schemaTypeSet = new Set<string>();
  let schemaErrors = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      collectSchemaTypes(JSON.parse(raw), schemaTypeSet);
    } catch {
      schemaErrors++;
    }
  });
  $("[itemtype]").each((_, el) => {
    const t = ($(el).attr("itemtype") ?? "").split("/").pop();
    if (t) schemaTypeSet.add(t);
  });

  // Open Graph / Twitter
  const openGraph: Record<string, string> = {};
  $("meta[property], meta[name]").each((_, el) => {
    const key = ($(el).attr("property") ?? $(el).attr("name") ?? "").toLowerCase();
    if (key.startsWith("og:") && !(key in openGraph)) openGraph[key] = cleanText($(el).attr("content"), 500);
  });
  const twitterCard = Boolean(metaByName("twitter:card"));

  // Client-side redirects: <meta http-equiv="refresh"> or a script that only sets location.
  let clientRedirect: PageData["clientRedirect"] = null;
  $("meta[http-equiv]").each((_, el) => {
    if (clientRedirect || ($(el).attr("http-equiv") ?? "").toLowerCase() !== "refresh") return;
    const m = /url\s*=\s*['"]?([^'";]+)/i.exec($(el).attr("content") ?? "");
    const r = m ? resolveHref(m[1], resolvedBase) : null;
    if (r) clientRedirect = { type: "meta", target: r.toString() };
  });
  if (!clientRedirect && wordCount < 50) {
    $("script:not([src])").each((_, el) => {
      if (clientRedirect) return;
      const m = /(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|location\.(?:replace|assign)\(\s*['"]([^'"]+)['"]/.exec($(el).contents().text());
      const target = m?.[1] ?? m?.[2];
      const r = target ? resolveHref(target, resolvedBase) : null;
      if (r) clientRedirect = { type: "script", target: r.toString() };
    });
  }

  return {
    title,
    metaDescription,
    h1,
    h2,
    canonical,
    robotsMeta,
    lang,
    hasViewport,
    wordCount,
    links,
    internalLinksCount: links.filter((l) => l.isInternal).length,
    externalLinksCount: links.filter((l) => !l.isInternal).length,
    imagesCount,
    imagesMissingAlt,
    imagesMissingAltSamples,
    imagesWithoutDimensions,
    scriptsCount,
    blockingScriptsCount,
    stylesheetsCount,
    mixedContentCount,
    schemaTypes: [...schemaTypeSet].slice(0, 30),
    schemaErrors,
    openGraph,
    twitterCard,
    clientRedirect,
  };
}
