/**
 * Polite feed polling: conditional requests and backing off when a publisher
 * asks us to slow down. Pure helpers (no I/O) so they can be unit-tested.
 */

/** How long to pause a feed after HTTP 429/503 when the publisher gives no Retry-After. */
export const DEFAULT_FEED_BACKOFF_MS = 60 * 60_000;
/** Never pause a feed for longer than this, whatever Retry-After says. */
export const MAX_FEED_BACKOFF_MS = 24 * 60 * 60_000;

/** Retry-After is either delay-seconds or an HTTP date. Returns the pause in ms, clamped to [1 min, 24 h]. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number {
  let ms = DEFAULT_FEED_BACKOFF_MS;
  const v = value?.trim();
  if (v) {
    if (/^\d+$/.test(v)) ms = Number(v) * 1000;
    else {
      const at = Date.parse(v);
      if (!Number.isNaN(at)) ms = at - now;
    }
  }
  return Math.min(MAX_FEED_BACKOFF_MS, Math.max(60_000, ms));
}

/** Request headers that let the publisher answer 304 Not Modified when the feed hasn't changed. */
export function conditionalHeaders(validators: { etag: string | null; lastModified: string | null }): Record<string, string> {
  const h: Record<string, string> = {};
  if (validators.etag) h["If-None-Match"] = validators.etag;
  if (validators.lastModified) h["If-Modified-Since"] = validators.lastModified;
  return h;
}

/** The publisher refused (401/403) or asked us to slow down (429/503): pause the feed instead of re-requesting it every run. */
export class FeedRateLimitedError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs: number,
  ) {
    super(
      status === 401 || status === 403
        ? `The publisher's website refuses the A3SEOMonitor crawler (HTTP ${status}); checking again in ${Math.round(retryAfterMs / 3_600_000)} h`
        : `The publisher asked us to slow down (HTTP ${status}); paused for ${Math.round(retryAfterMs / 60_000)} min`,
    );
    this.name = "FeedRateLimitedError";
  }
}
