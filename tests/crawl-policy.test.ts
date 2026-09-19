import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedBackoffHours, consecutiveBlocked, isRetryable, nextBlockState } from "@/lib/seo/crawl-policy";
import { computeOutcome } from "@/lib/seo/outcome";
import { allRegions, resolveRegion } from "@/lib/crawler/regions";
import { pagePriority } from "@/lib/seo/url";

test("refusals are never retried; temporary failures are", () => {
  assert.equal(isRetryable(403, null), false);
  assert.equal(isRetryable(429, null), false);
  assert.equal(isRetryable(200, null, true), false);
  assert.equal(isRetryable(503, null), true);
  assert.equal(isRetryable(null, "TIMEOUT"), true);
  assert.equal(isRetryable(404, null), false);
});

test("crawling stops on rate limiting or repeated blocks", () => {
  assert.deepEqual(nextBlockState(0, { status: 429, blocked: false }).stop, true);
  const first = nextBlockState(0, { status: 403, blocked: true });
  assert.equal(first.stop, false);
  assert.equal(nextBlockState(first.streak, { status: 403, blocked: true }).stop, true);
  assert.equal(nextBlockState(1, { status: 200, blocked: false }).streak, 0);
});

test("blocked sites are rescanned less often, within limits", () => {
  assert.equal(blockedBackoffHours(24, 0), 24);
  assert.equal(blockedBackoffHours(24, 1), 48);
  assert.equal(blockedBackoffHours(24, 5), 168);
  assert.equal(blockedBackoffHours(6, 3), 48);
});

test("scan outcomes separate access problems from SEO results", () => {
  const base = { crawlBlocked: false, siteAvailable: true, pagesBlocked: 0, pagesNotEvaluated: 0, pagesFailedOther: 0, stoppedForBlock: false };
  assert.equal(computeOutcome(base), "completed");
  assert.equal(computeOutcome({ ...base, pagesFailedOther: 2 }), "completed_with_warnings");
  assert.equal(computeOutcome({ ...base, pagesNotEvaluated: 5, stoppedForBlock: true }), "partially_blocked");
  assert.equal(computeOutcome({ ...base, crawlBlocked: true }), "blocked");
});

test("regions: preferred region if known, else the default US region", () => {
  const regions = allRegions("eu-west:EU-West");
  assert.equal(resolveRegion("us-west", "us-east", regions), "us-west");
  assert.equal(resolveRegion("eu-west", "us-east", regions), "eu-west");
  assert.equal(resolveRegion("mars-1", "us-east", regions), "us-east");
  assert.equal(resolveRegion(null, "us-east", regions), "us-east");
});

test("important pages are crawled first, in the configured order", () => {
  const order = (["blog", "contact", "home", "service", "used_inventory", "new_inventory", "parts", "finance", "about", "other"] as const)
    .map((t) => ({ t, p: pagePriority(t, { depth: 1, navLinked: true }) }))
    .sort((a, b) => a.p - b.p)
    .map((x) => x.t);
  assert.deepEqual(order, ["home", "new_inventory", "used_inventory", "service", "parts", "finance", "about", "contact", "blog", "other"]);
  // A nav-linked service page beats a sitemap-only one; any service page beats a blog post.
  assert.ok(pagePriority("service", { depth: 1, navLinked: true }) < pagePriority("service", { depth: 1, fromSitemap: true }));
  assert.ok(pagePriority("service", { depth: 3, fromSitemap: true }) < pagePriority("blog", { depth: 1, navLinked: true }));
});

test("only consecutive blocked scans, newest first, slow down a site's schedule", () => {
  assert.equal(consecutiveBlocked([]), 0);
  assert.equal(consecutiveBlocked(["completed", "blocked"]), 0, "a successful scan after a block resets the streak");
  assert.equal(consecutiveBlocked(["blocked", "completed", "blocked"]), 1);
  assert.equal(consecutiveBlocked(["blocked", "blocked", "partially_blocked"]), 2);
  assert.equal(consecutiveBlocked(["blocked", null]), 1);
});

test("dropped connections are recognised as transient, real query errors are not", async () => {
  const { isTransientNetworkError } = await import("@/lib/errors");
  const reset = Object.assign(new Error("Failed query: select 1"), { cause: Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }) });
  assert.equal(isTransientNetworkError(reset), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error("Failed query"), { cause: new Error("write CONNECT_TIMEOUT undefined:undefined") })), true);
  assert.equal(isTransientNetworkError(Object.assign(new Error("Failed query"), { cause: new Error('column "x" does not exist') })), false);
  assert.equal(isTransientNetworkError("boom"), false);
});
