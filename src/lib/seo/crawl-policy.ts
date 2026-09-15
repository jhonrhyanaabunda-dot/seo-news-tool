/**
 * Crawl politeness & block-handling rules. Pure functions so they can be unit tested.
 *
 * The monitor never tries to get around a website's security controls: when a
 * site refuses access it records that, stops, and reports the pages as
 * "not evaluated" instead of guessing.
 */

export const CRAWL_POLICY = {
  /** Stop crawling a site after this many consecutive refused/challenged responses. */
  blockStreakToStop: 2,
  /** Stop immediately on HTTP 429 (the site asked us to slow down). */
  stopOnRateLimit: true,
  /** Re-use robots.txt / sitemap downloads for this long. */
  robotsCacheHours: 12,
  sitemapCacheHours: 24,
  /** After consecutive blocked scans, wait interval × 2^streak (capped) before trying again. */
  maxBlockedBackoffFactor: 8,
  maxBlockedBackoffHours: 168,
};

/**
 * Retry only failures that are likely temporary (timeouts, dropped
 * connections, server errors). Never retry refusals — 401/403/429 or a
 * challenge page — because repeating them can trigger stronger protection.
 */
export function isRetryable(status: number | null, errorCode: string | null, blocked = false): boolean {
  if (blocked) return false;
  if (status === 401 || status === 403 || status === 429) return false;
  if (status !== null && status >= 500) return true;
  return errorCode === "TIMEOUT" || errorCode === "CONNECTION";
}

/** Update the consecutive-block counter after a response and decide whether to stop crawling the site. */
export function nextBlockState(streak: number, res: { status: number | null; blocked: boolean }): { streak: number; stop: boolean; rateLimited: boolean } {
  const rateLimited = res.status === 429;
  if (rateLimited && CRAWL_POLICY.stopOnRateLimit) return { streak: streak + 1, stop: true, rateLimited };
  if (!res.blocked && !rateLimited) return { streak: 0, stop: false, rateLimited };
  const next = streak + 1;
  return { streak: next, stop: next >= CRAWL_POLICY.blockStreakToStop, rateLimited };
}

/** Hours to wait before the next scheduled scan of a site whose recent scans were blocked. */
export function blockedBackoffHours(intervalHours: number, blockedStreak: number): number {
  if (blockedStreak <= 0) return intervalHours;
  const factor = Math.min(2 ** blockedStreak, CRAWL_POLICY.maxBlockedBackoffFactor);
  return Math.min(intervalHours * factor, Math.max(intervalHours, CRAWL_POLICY.maxBlockedBackoffHours));
}
