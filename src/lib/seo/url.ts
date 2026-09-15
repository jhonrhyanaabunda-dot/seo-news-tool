/**
 * URL normalisation and dealership page classification. Pure functions —
 * no I/O — so they are easy to unit test and reuse in the worker.
 */

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "gclid", "fbclid", "msclkid", "dclid", "mc_cid", "mc_eid", "ref", "referrer", "_ga", "_gl",
]);

const SKIP_EXTENSIONS = /\.(?:pdf|jpe?g|png|gif|webp|svg|ico|bmp|tiff?|mp4|mov|avi|webm|mp3|wav|zip|gz|tar|rar|7z|dmg|exe|msi|apk|css|js|json|xml|txt|csv|xlsx?|docx?|pptx?|woff2?|ttf|eot)$/i;

/** Lowercase host with a leading "www." removed. */
export function canonicalHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
}

/** True if two URLs belong to the same website (ignoring www and scheme). */
export function isSameSite(a: URL, b: URL): boolean {
  return canonicalHost(a.hostname) === canonicalHost(b.hostname);
}

/**
 * Normalise a URL for deduplication: lowercase host, drop fragment, drop
 * tracking params, sort remaining params, remove default ports and trailing
 * slashes (except root). Scheme is preserved.
 */
export function normalizeUrl(input: string | URL): string {
  const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
  url.hash = "";
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === "http:" && url.port === "80") || (url.protocol === "https:" && url.port === "443")) url.port = "";
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  url.search = "";
  for (const [k, v] of params) url.searchParams.append(k, v);
  let path = url.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  url.pathname = path;
  return url.toString();
}

/**
 * The address to actually request for a discovered URL: the site's own form
 * (trailing slash kept) without fragment or tracking parameters. normalizeUrl()
 * is for de-duplication only — requesting its slash-stripped form made sites that
 * use trailing slashes answer every page with a redirect, doubling requests.
 */
export function requestUrl(input: string | URL): string {
  const url = typeof input === "string" ? new URL(input) : new URL(input.toString());
  url.hash = "";
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()));
  url.search = "";
  for (const [k, v] of params) url.searchParams.append(k, v);
  return url.toString();
}

/** Compare two URLs ignoring scheme, www, trailing slash and tracking params. */
export function urlsEquivalent(a: string, b: string): boolean {
  try {
    const na = new URL(normalizeUrl(a));
    const nb = new URL(normalizeUrl(b));
    return canonicalHost(na.hostname) === canonicalHost(nb.hostname) && na.pathname === nb.pathname && na.search === nb.search;
  } catch {
    return false;
  }
}

/** Resolve an href found on a page. Returns null for non-crawlable schemes. */
export function resolveHref(href: string, base: string): URL | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (/^(mailto|tel|sms|javascript|data|ftp|file|whatsapp|skype|fax|callto):/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url;
  } catch {
    return null;
  }
}

/** Whether a URL looks like an HTML page worth crawling (not an asset). */
export function looksLikeHtmlPage(url: URL): boolean {
  return !SKIP_EXTENSIONS.test(url.pathname);
}

export type PageType =
  | "home"
  | "new_inventory"
  | "used_inventory"
  | "vehicle_detail"
  | "service"
  | "parts"
  | "finance"
  | "specials"
  | "about"
  | "contact"
  | "blog"
  | "search"
  | "other";

const VIN_RE = /[A-HJ-NPR-Z0-9]{17}/i;

/** Classify a dealership URL by path (deterministic, pattern based). */
export function classifyPath(url: URL): PageType {
  const p = url.pathname.toLowerCase();
  if (p === "/" || p === "" || p === "/index.htm" || p === "/index.html" || p === "/home") return "home";
  if (VIN_RE.test(p) || /\/(vehicle-details?|vdp|inventory\/[^/]+\/[^/]+|vehicles?\/[^/]+\/[^/]+|detail)\b/.test(p)) return "vehicle_detail";
  if (/\/(search|searchnew|searchused|search-results)/.test(p) || url.searchParams.has("q")) return "search";
  // Departments first: "/specials/new.htm" is a specials page, not inventory.
  if (/\/(specials?|offers?|deals?|incentives?|promotions?|coupons?|lease-specials)(\/|\.|-|$)/.test(p)) return "specials";
  if (/\/(service|schedule-service|maintenance|oil-change|tires?|brakes?|collision|body-shop|repair)(\/|\.|-|$)/.test(p)) return "service";
  if (/\/(parts|accessories|order-parts|tire-center)(\/|\.|-|$)/.test(p)) return "parts";
  if (/\/(finance|financing|credit|apply|loan|lease|payment|pre-?approv)/.test(p)) return "finance";
  if (/\/(about|our-team|staff|meet-|dealership\/|why-buy|reviews|testimonials|careers?|community)/.test(p)) return "about";
  if (/\/(contact|hours|directions|location|map)(\/|\.|-|$)/.test(p)) return "contact";
  if (/\/(blog|news|articles?|press|events?)(\/|\.|-|$)/.test(p)) return "blog";
  if (/(^|\/)(used|pre-?owned|certified|cpo)(\/|\.|-|$)/.test(p) || /used-(vehicles?|inventory|cars?)/.test(p)) return "used_inventory";
  if (/(^|\/)(new|new-vehicles?|new-inventory|new-cars?|newinventory|searchnew)(\/|\.|-|$)/.test(p) || /inventory\/new/.test(p)) return "new_inventory";
  if (/\/(inventory|vehicles?|showroom|models?)/.test(p)) return "new_inventory";
  return "other";
}

export interface ImportantPageDef {
  key: string;
  label: string;
  pageTypes: PageType[];
  anchorPatterns: RegExp;
}

/** Pages every dealership website is expected to have. */
export const IMPORTANT_PAGES: ImportantPageDef[] = [
  { key: "new_inventory", label: "New vehicle inventory", pageTypes: ["new_inventory"], anchorPatterns: /\b(new (vehicles?|inventory|cars?)|shop new|view new)\b/i },
  { key: "used_inventory", label: "Used / pre-owned inventory", pageTypes: ["used_inventory"], anchorPatterns: /\b(used|pre-?owned|certified)\b/i },
  { key: "service", label: "Service department", pageTypes: ["service"], anchorPatterns: /\b(schedule service|service (center|department)|service\b)/i },
  { key: "parts", label: "Parts department", pageTypes: ["parts"], anchorPatterns: /\b(parts|accessories)\b/i },
  { key: "finance", label: "Financing", pageTypes: ["finance"], anchorPatterns: /\b(financ(e|ing)|get pre-?approved|apply for credit)\b/i },
  { key: "specials", label: "Specials / offers", pageTypes: ["specials"], anchorPatterns: /\b(specials?|offers?|deals?|incentives?)\b/i },
  { key: "about", label: "About the dealership", pageTypes: ["about"], anchorPatterns: /\b(about( us)?|our (team|story|dealership)|meet (the|our))\b/i },
  { key: "contact", label: "Contact / hours & directions", pageTypes: ["contact"], anchorPatterns: /\b(contact( us)?|hours|directions|get directions)\b/i },
];

/**
 * Crawl order by page type — lower is crawled first. On large sites the page
 * budget (max pages per dealership) is spent on these first:
 * homepage → new inventory → used inventory → service → parts → finance →
 * about → contact → specials → blog/articles → other SEO/pillar pages.
 */
export const PAGE_TYPE_PRIORITY: Record<PageType, number> = {
  home: 0,
  new_inventory: 1,
  used_inventory: 2,
  service: 3,
  parts: 4,
  finance: 5,
  about: 6,
  contact: 7,
  specials: 8,
  blog: 9,
  other: 10,
  vehicle_detail: 11,
  search: 12,
};

/**
 * Frontier priority for a URL: page-type rank first; within a type, pages
 * linked from the site's navigation beat sitemap-only URLs, and shallower
 * pages (likely pillar pages) beat deeper ones.
 */
export function pagePriority(type: PageType, opts: { depth: number; fromSitemap?: boolean; navLinked?: boolean }): number {
  return PAGE_TYPE_PRIORITY[type] * 100 + (opts.fromSitemap ? 50 : 0) + (opts.navLinked ? 0 : 10) + Math.min(opts.depth, 9);
}

/** Per-scan caps so inventory-heavy dealership sites are sampled, not exhausted. */
export const PAGE_TYPE_CAPS: Partial<Record<PageType, number>> = {
  vehicle_detail: 3,
  new_inventory: 6,
  used_inventory: 6,
  search: 1,
  blog: 6,
};

export function isImportantType(type: PageType): boolean {
  return type === "home" || IMPORTANT_PAGES.some((p) => p.pageTypes.includes(type));
}
