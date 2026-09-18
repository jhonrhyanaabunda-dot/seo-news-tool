import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyPageResult, isAnalyzed, isEmptyDocument, isProtected } from "@/lib/seo/result-class";
import { crawlJobStatus } from "@/lib/jobs/status";
import { detectPlatform } from "@/lib/seo/platform";
import { CHECK_PRIORITY, priorityFor, reportGroupFor } from "@/lib/seo/priority";
import { CHECKS } from "@/lib/seo/checks/config";
import { applyEnvAliases } from "@/lib/env-aliases";
import { orderSitemapUrls, sitemapCandidates } from "@/lib/seo/sitemap-seed";

const page = (p: Partial<Parameters<typeof classifyPageResult>[0]>) =>
  classifyPageResult({ status: "fetched", httpStatus: 200, errorCode: null, errorMessage: null, redirected: false, ...p });

test("URL results are classified without treating protection as an error", () => {
  assert.equal(page({}), "SUCCESS");
  assert.equal(page({ redirected: true }), "REDIRECT");
  assert.equal(page({ httpStatus: 301 }), "REDIRECT");
  assert.equal(page({ httpStatus: 404, errorCode: "HTTP_ERROR" }), "NOT_FOUND");
  assert.equal(page({ httpStatus: 503, errorCode: "HTTP_ERROR" }), "SERVER_ERROR");
  assert.equal(page({ status: "failed", httpStatus: 403, errorCode: "BLOCKED", errorMessage: "Cloudflare bot protection returned a challenge page" }), "PROTECTED");
  assert.equal(page({ status: "failed", httpStatus: 403, errorCode: "BLOCKED", errorMessage: "The website refused the scanner (HTTP 403) — Cloudflare" }), "ACCESS_DENIED");
  assert.equal(page({ status: "failed", httpStatus: 429, errorCode: "BLOCKED" }), "RATE_LIMITED");
  assert.equal(page({ status: "failed", httpStatus: null, errorCode: "TIMEOUT" }), "TIMEOUT");
  assert.equal(page({ status: "failed", httpStatus: null, errorCode: "DNS" }), "NETWORK_ERROR");
  assert.equal(page({ status: "skipped", httpStatus: null, errorCode: "NOT_EVALUATED" }), "NOT_EVALUATED");
  assert.equal(page({ status: "skipped", httpStatus: null, errorCode: "ROBOTS_BLOCKED" }), "SKIPPED");
  assert.equal(page({ status: "pending", httpStatus: null }), null);
  assert.ok(isProtected("PROTECTED") && isProtected("ACCESS_DENIED") && isProtected("RATE_LIMITED") && isProtected("NOT_EVALUATED"));
  assert.ok(!isProtected("NOT_FOUND") && isAnalyzed("REDIRECT") && !isAnalyzed("PROTECTED"));
});

test("a scan with protected pages is PARTIAL, never FAILED", () => {
  assert.equal(crawlJobStatus({ status: "queued", outcome: null }), "QUEUED");
  assert.equal(crawlJobStatus({ status: "crawling", outcome: null }), "RUNNING");
  assert.equal(crawlJobStatus({ status: "finalizing", outcome: null }), "RUNNING");
  assert.equal(crawlJobStatus({ status: "completed", outcome: "completed" }), "COMPLETED");
  assert.equal(crawlJobStatus({ status: "completed", outcome: "completed_with_warnings" }), "COMPLETED");
  assert.equal(crawlJobStatus({ status: "completed", outcome: "partially_blocked" }), "PARTIAL");
  assert.equal(crawlJobStatus({ status: "completed", outcome: "blocked" }), "PARTIAL");
  assert.equal(crawlJobStatus({ status: "failed", outcome: "failed" }), "FAILED");
  assert.equal(crawlJobStatus({ status: "cancelled", outcome: null }), "FAILED");
});

test("website platforms are recognised from homepage markup", () => {
  assert.equal(detectPlatform('<script src="https://cdn.dealerinspire.com/a.js"></script><link href="/wp-content/x.css">'), "Dealer Inspire", "dealer platform wins over its WordPress base");
  assert.equal(detectPlatform('<img src="https://pictures.dealer.com/b/bmw/1.jpg">'), "Dealer.com");
  assert.equal(detectPlatform('<script src="https://cdn.dealeron.com/x.js"></script>'), "DealerOn");
  assert.equal(detectPlatform('<link rel="stylesheet" href="/wp-content/themes/x/style.css">'), "WordPress");
  assert.equal(detectPlatform("<html><body>Plain site</body></html>"), null);
  assert.equal(detectPlatform('<a href="https://www.bmwdealer.com/offers">Offers</a>'), null, "a domain merely ending in dealer.com is not Dealer.com");
  assert.equal(detectPlatform(readFileSync("tests/fixtures/dealer-inspire-block.html", "utf8")), "Dealer Inspire");
});

test("every SEO check has a report priority consistent with its stored severity", () => {
  for (const c of CHECKS) {
    const p = CHECK_PRIORITY[c.key];
    assert.ok(p, `${c.key} has no priority`);
    if (c.severity === "critical") assert.equal(p, "CRITICAL", c.key);
    if (c.severity === "warning") assert.ok(p === "HIGH" || p === "MEDIUM", `${c.key}: ${p}`);
    if (c.severity === "info") assert.equal(p, "LOW", c.key);
    assert.ok(reportGroupFor(c.key));
  }
  assert.equal(priorityFor("some_future_check", "critical"), "CRITICAL");
});

test("friendly crawler setting names map onto the originals, which still win", () => {
  const e = applyEnvAliases({ MAX_PAGES_PER_DEALERSHIP: "80", REQUEST_DELAY: "1500", MAX_RETRIES: "2", CRAWLER_TIMEOUT_MS: "20000", REQUEST_TIMEOUT: "5000" });
  assert.equal(e.CRAWLER_DEFAULT_MAX_PAGES, "80");
  assert.equal(e.CRAWLER_DELAY_MS, "1500");
  assert.equal(e.CRAWLER_MAX_RETRIES, "2");
  assert.equal(e.CRAWLER_TIMEOUT_MS, "20000", "an explicit original setting is not overridden");
});

test("sitemap URLs are ordered by dealership page importance, deterministically", () => {
  const order = orderSitemapUrls([
    "https://d.com/inventory/2024-subaru-wrx-jf1vbab60p8815677",
    "https://d.com/blog/tips",
    "https://d.com/service",
    "https://d.com/new-vehicles/",
    "https://d.com/brochure.pdf",
    "https://d.com/service",
    "not a url",
  ]).map((u) => u.pathname);
  assert.deepEqual(order, ["/new-vehicles/", "/service", "/blog/tips", "/inventory/2024-subaru-wrx-jf1vbab60p8815677"]);
  assert.deepEqual(sitemapCandidates("https://d.com/custom.xml", ["https://d.com/sitemap.xml", "https://d.com/custom.xml"]), ["https://d.com/custom.xml", "https://d.com/sitemap.xml"]);
});

test("an empty 200 document is not analysed as a page missing its title and headings", () => {
  assert.equal(isEmptyDocument(""), true);
  assert.equal(isEmptyDocument(null), true);
  assert.equal(isEmptyDocument("<html><head></head><body></body></html>"), true);
  assert.equal(isEmptyDocument("<html><head><script>var x = 1;</script></head><body>  </body></html>"), true);
  assert.equal(isEmptyDocument("<html><head><title>BMW M4</title></head><body></body></html>"), false);
  assert.equal(isEmptyDocument("<html><body><p>New BMW M4 in stock</p></body></html>"), false);
  assert.equal(classifyPageResult({ status: "failed", httpStatus: 200, errorCode: "EMPTY_RESPONSE" }), "NETWORK_ERROR");
});
