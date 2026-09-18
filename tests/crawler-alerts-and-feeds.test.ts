import { test } from "node:test";
import assert from "node:assert/strict";
import { conditionalHeaders, DEFAULT_FEED_BACKOFF_MS, FeedRateLimitedError, MAX_FEED_BACKOFF_MS, parseRetryAfter } from "@/lib/news/feed-http";
import { renderCrawlerStatusEmail } from "@/lib/email/templates";

test("Retry-After is honoured as seconds or an HTTP date, within sensible bounds", () => {
  const now = Date.parse("2026-09-15T12:00:00Z");
  assert.equal(parseRetryAfter("120", now), 120_000);
  assert.equal(parseRetryAfter("Tue, 15 Sep 2026 12:30:00 GMT", now), 30 * 60_000);
  assert.equal(parseRetryAfter(null, now), DEFAULT_FEED_BACKOFF_MS);
  assert.equal(parseRetryAfter("soon", now), DEFAULT_FEED_BACKOFF_MS);
  assert.equal(parseRetryAfter("1", now), 60_000, "at least a minute");
  assert.equal(parseRetryAfter("999999", now), MAX_FEED_BACKOFF_MS, "at most a day");
});

test("conditional feed requests send only the validators we have", () => {
  assert.deepEqual(conditionalHeaders({ etag: null, lastModified: null }), {});
  assert.deepEqual(conditionalHeaders({ etag: '"abc"', lastModified: "Tue, 15 Sep 2026 10:00:00 GMT" }), { "If-None-Match": '"abc"', "If-Modified-Since": "Tue, 15 Sep 2026 10:00:00 GMT" });
});

test("crawler offline and recovery emails say what is waiting and what to do", () => {
  const base = {
    regions: ["us-east"],
    since: new Date("2026-09-15T13:00:00Z"),
    lastCrawler: { id: "crawler-us-east-mac.local-4921", lastSeenAt: new Date("2026-09-15T12:55:00Z") },
    systemUrl: "https://app/admin/system",
    dashboardUrl: "https://app",
    timeZone: "America/Chicago",
  };
  const off = renderCrawlerStatusEmail({ ...base, status: "offline", waitingScans: 2 });
  assert.equal(off.subject, "⚠ SEO scans are waiting: no crawler online");
  assert.match(off.text, /2 SEO scans are queued for us-east, the oldest since Sep 15, 8:00\s?AM CDT/);
  assert.match(off.text, /Last crawler seen: crawler-us-east-mac\.local-4921/);
  assert.match(off.text, /nothing is lost/);
  assert.match(off.text, /Admin → System: https:\/\/app\/admin\/system/);

  const on = renderCrawlerStatusEmail({ ...base, status: "online", waitingScans: 0 });
  assert.equal(on.subject, "Crawler back online: SEO scans are running again");
  assert.match(on.text, /online again in us-east \(crawler-us-east-mac\.local-4921\)/);
  assert.ok(on.html.includes("Resolved"));
});

test("a publisher's refusal and a slow-down request are explained differently", () => {
  assert.match(new FeedRateLimitedError(403, MAX_FEED_BACKOFF_MS).message, /refuses the A3SEOMonitor crawler \(HTTP 403\); checking again in 24 h/);
  assert.match(new FeedRateLimitedError(429, 30 * 60_000).message, /asked us to slow down \(HTTP 429\); paused for 30 min/);
});
