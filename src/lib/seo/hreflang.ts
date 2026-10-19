/**
 * hreflang validation. Pure functions (no I/O), used by evaluateScan.
 *
 * Codes are validated by syntax (BCP 47 style: a 2–3 letter language, an
 * optional 4-letter script, an optional 2-letter or 3-digit region, or
 * "x-default") rather than against full ISO tables, plus the mistakes that
 * actually occur on dealer sites: underscores ("en_US"), "UK" for the United
 * Kingdom (ISO uses "GB") and a country written where the language belongs.
 */

const CODE_RE = /^([a-z]{2,3})(?:-([a-z]{4}))?(?:-([a-z]{2}|\d{3}))?$/i;
/** Country codes that are not language codes but are often written as one ("us" instead of "en-US"). */
const COUNTRY_AS_LANGUAGE = new Set(["us", "uk", "gb", "eu", "jp", "cn"]);
/** Region subtags that look right but are not ISO 3166-1 codes, with the correct one. */
const WRONG_REGIONS: Record<string, string> = { uk: "GB", eu: "" };

/** Why an hreflang value is invalid, or null when it is acceptable. */
export function hreflangCodeProblem(value: string): string | null {
  const v = value.trim();
  if (v.toLowerCase() === "x-default") return null;
  if (v.includes("_")) return `"${v}" uses an underscore; use a hyphen ("${v.replace(/_/g, "-")}")`;
  const m = CODE_RE.exec(v);
  if (!m) return `"${v}" is not a valid language code`;
  const [, lang, , region] = m;
  if (COUNTRY_AS_LANGUAGE.has(lang.toLowerCase())) return `"${v}" starts with a country, not a language (e.g. "en-US")`;
  const wrong = region ? WRONG_REGIONS[region.toLowerCase()] : undefined;
  if (wrong !== undefined) return wrong ? `"${v}" is not a valid region; use "${lang}-${wrong}"` : `"${v}" is not a valid region code`;
  return null;
}

export interface HreflangPage {
  url: string;
  finalUrl: string | null;
  canonical: string | null;
  hreflang: Array<{ lang: string; href: string }>;
}

/**
 * Problems with one page's hreflang set. `crawled` resolves a URL to another
 * page of the same scan (or undefined when it was not crawled); return links
 * are only checked for alternates that were crawled, so nothing is assumed
 * about pages the scanner did not see.
 */
export function hreflangProblems(page: HreflangPage, crawled: (url: string) => HreflangPage | undefined, same: (a: string, b: string) => boolean): string[] {
  const set = page.hreflang;
  if (!set.length) return [];
  const problems: string[] = [];
  const self = [page.url, page.finalUrl, page.canonical].filter((u): u is string => Boolean(u));
  const isSelf = (href: string) => self.some((u) => same(u, href));

  for (const a of set) {
    const p = hreflangCodeProblem(a.lang);
    if (p && !problems.includes(p)) problems.push(p);
  }
  const byLang = new Map<string, Set<string>>();
  for (const a of set) {
    const k = a.lang.trim().toLowerCase();
    const hrefs = byLang.get(k) ?? new Set<string>();
    if (![...hrefs].some((h) => same(h, a.href))) hrefs.add(a.href);
    byLang.set(k, hrefs);
  }
  for (const [lang, hrefs] of byLang) if (hrefs.size > 1) problems.push(`"${lang}" points to ${hrefs.size} different URLs`);
  if (!set.some((a) => isSelf(a.href))) problems.push("the page does not list itself as one of the alternates");
  if (byLang.size > 1 && !byLang.has("x-default")) problems.push('no "x-default" alternate');

  const missingReturn: string[] = [];
  for (const a of set) {
    if (isSelf(a.href)) continue;
    const target = crawled(a.href);
    if (!target) continue;
    if (!target.hreflang.some((b) => self.some((u) => same(u, b.href)))) missingReturn.push(a.href);
  }
  if (missingReturn.length) problems.push(`no return link from ${missingReturn.slice(0, 3).join(", ")}${missingReturn.length > 3 ? ` and ${missingReturn.length - 3} more` : ""}`);
  return problems;
}
