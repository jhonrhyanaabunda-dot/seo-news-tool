/**
 * Developer-facing crawl progress on stdout (worker logs, `npm run crawler`):
 *
 *   [Crawler] Dealership: BMW of Fort Walton Beach (https://www.bmwfwb.com/)
 *   [Crawler] Sitemap discovered: 243 URLs (30 queued)
 *   [Crawler] Crawling URL 12/30 /service
 *   [Crawler] Protected: /service/example (Cloudflare challenge)
 *   [Crawler] Completed: 27 analyzed / 2 protected / 1 other (score 86)
 *
 * Not persisted and never shown in the dashboard; user-facing history lives in
 * scan_events. Silence with CRAWLER_LOGS=false (tests set NODE_ENV=test).
 */
export function crawlerLog(message: string): void {
  if (process.env.CRAWLER_LOGS === "false" || process.env.NODE_ENV === "test") return;
  console.log(`[Crawler] ${message}`);
}

/** Path + query only, so log lines stay readable. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  } catch {
    return url;
  }
}
