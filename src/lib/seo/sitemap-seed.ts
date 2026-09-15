/**
 * Sitemap-first crawl ordering. Pure function.
 *
 * The site's own sitemap says which pages it wants indexed, so those URLs are
 * the crawl frontier; links discovered on pages only fill whatever page budget
 * is left. Large dealer sitemaps are mostly inventory, so URLs are ordered by
 * dealership page importance (inventory landing pages, service, parts…) before
 * depth, deterministically, and per-type caps keep vehicle detail pages sampled.
 */
import { PAGE_TYPE_PRIORITY, classifyPath, looksLikeHtmlPage } from "./url";

export function orderSitemapUrls(urls: string[]): URL[] {
  const seen = new Set<string>();
  const parsed: URL[] = [];
  for (const raw of urls) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const key = u.toString();
    if (seen.has(key) || !looksLikeHtmlPage(u)) continue;
    seen.add(key);
    parsed.push(u);
  }
  return parsed.sort(
    (a, b) =>
      PAGE_TYPE_PRIORITY[classifyPath(a)] - PAGE_TYPE_PRIORITY[classifyPath(b)] ||
      a.pathname.split("/").length - b.pathname.split("/").length ||
      (a.toString() < b.toString() ? -1 : 1),
  );
}

/** Put an admin-configured sitemap ahead of the robots.txt ones, without duplicates. */
export function sitemapCandidates(configured: string | null | undefined, fromRobots: string[]): string[] {
  const list = configured ? [configured, ...fromRobots] : fromRobots;
  return [...new Set(list.map((s) => s.trim()).filter(Boolean))];
}
