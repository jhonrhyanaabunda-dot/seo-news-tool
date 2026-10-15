import { test } from "node:test";
import assert from "node:assert/strict";
import { isBrokenLink } from "@/lib/seo/links";
import { classifyPageResult, isIncompleteRender } from "@/lib/seo/result-class";
import { evaluateScan, type EvalPage, type EvalSite } from "@/lib/seo/checks/evaluate";
import { THRESHOLDS } from "@/lib/seo/checks/config";
import { isForeignMarketStory, isForeignPublisher, namesOtherMake, scoreArticle } from "@/lib/news/relevance";

/**
 * Each test pins a false finding seen in production (October 2026 data audit),
 * so the fix cannot quietly regress.
 */

test("a link check that times out is unverified, not broken (Subaru: Links 100 ↔ 38 on alternate scans)", () => {
  assert.equal(isBrokenLink(true, null, "TIMEOUT"), false);
  assert.equal(isBrokenLink(false, null, "TIMEOUT"), false);
  // Real failures still count.
  assert.equal(isBrokenLink(true, 404, null), true);
  assert.equal(isBrokenLink(true, null, "DNS"), true);
  assert.equal(isBrokenLink(true, null, "CONNECTION"), true);
});

test("a browser render without its <head> is incomplete, not a page missing ten things", () => {
  const shell = `<html><body><nav><a href="/new">New</a><a href="/used">Used</a></nav><script>app()</script></body></html>`;
  assert.equal(isIncompleteRender(shell), true);
  assert.equal(isIncompleteRender(`<html lang="en"><head><title>BMW of Fort Walton Beach</title><meta name="viewport" content="width=device-width"></head><body></body></html>`), false);
  // Any one of the three is enough to show the document was built.
  assert.equal(isIncompleteRender(`<html><head><title>Service</title></head><body>x</body></html>`), false);
  assert.equal(isIncompleteRender(`<html lang="en"><body>x</body></html>`), false);
  assert.equal(isIncompleteRender(`<html><head><title> </title></head><body><a href="/">x</a></body></html>`), true, "a blank title does not count");
  assert.equal(isIncompleteRender(null), false);
  // Recorded as not analysed, never as a successful page.
  assert.equal(classifyPageResult({ status: "failed", httpStatus: 200, errorCode: "INCOMPLETE_RENDER" }), "NETWORK_ERROR");
});

const BASE = "https://www.example-dealer.com";
const site: EvalSite = {
  baseUrl: `${BASE}/`,
  siteAvailable: true,
  homepageStatus: 200,
  homepageErrorCode: null,
  robots: { found: true, blocksAll: false, blocksGooglebot: false, sitemaps: [] },
  sitemap: { found: true, urlCount: 50 },
  importantPages: [],
};
const page = (path: string, responseTimeMs: number): EvalPage =>
  ({
    id: 1, url: `${BASE}${path}`, finalUrl: `${BASE}${path}`, status: "fetched", pageType: "other", isImportant: false, httpStatus: 200,
    responseTimeMs, htmlBytes: 60_000, title: "A clear descriptive page title for the page", metaDescription: "A meta description that comfortably clears the minimum length while staying under the maximum length.",
    h1: ["Heading"], h2: ["Sub"], canonical: `${BASE}${path}`, robotsMeta: null, xRobotsTag: null, lang: "en", hasViewport: true, wordCount: 600,
    internalLinksCount: 25, imagesCount: 8, imagesMissingAlt: 0, blockingScriptsCount: 1, schemaTypes: ["AutoDealer"], schemaErrors: 0,
    openGraph: { "og:title": "t", "og:description": "d", "og:image": "i" }, errorCode: null, details: {}, resultClass: "SUCCESS", redirected: false,
  }) as unknown as EvalPage;
const slow = (pages: EvalPage[], s: EvalSite) => evaluateScan(pages, [], s).issues.filter((i) => i.checkKey === "slow_response").map((i) => i.url);

test("one slow reading is a blip; slow twice in a row, or far over, is reported", () => {
  const t = THRESHOLDS.slowResponseMs;
  const pages = [page("/blip", t + 500), page("/again", t + 500), page("/far", 2 * t + 1), page("/fast", 900)];
  const prev = new Set([`${BASE}/again`]);
  assert.deepEqual(slow(pages, { ...site, previouslySlowUrls: prev }).sort(), [`${BASE}/again`, `${BASE}/far`]);
  // No previous scan to compare with: behaves as before and reports every slow page.
  assert.deepEqual(slow(pages, site).sort(), [`${BASE}/again`, `${BASE}/blip`, `${BASE}/far`]);
});

const subaru = [
  { keyword: "Findlay Subaru of Las Vegas", kind: "dealership" as const },
  { keyword: "Findlay Automotive Group", kind: "group" as const },
  { keyword: "Subaru", kind: "brand" as const },
  { keyword: "Las Vegas", kind: "local" as const },
];

test("another make's local dealership is not this dealership's news", () => {
  // Seen as "dealership news" for Findlay Subaru of Las Vegas.
  assert.equal(scoreArticle("Findlay Kia Las Vegas dealership celebrates grand opening", subaru).score, 0);
  assert.equal(scoreArticle("Centennial Volkswagen named top Las Vegas dealership", subaru).score, 0);
  assert.equal(scoreArticle("Toyota seeks dealers' help with tariffs, shows new products in Las Vegas", subaru).score, 0);
  // Local dealership news without another make is still kept (earlier behaviour).
  assert.equal(scoreArticle("Las Vegas dealership donates backpacks to students", subaru).scope, "dealership");
  // This store, or its group, always wins.
  assert.equal(scoreArticle("Findlay Automotive Group opens new Kia store in Las Vegas", subaru).scope, "dealership");
  assert.equal(namesOtherMake("Subaru Outback wins award", ["Subaru"]), false);
  assert.equal(namesOtherMake("Mercedes-Benz dealer expands", ["Mercedes-Benz"]), false);
  assert.equal(namesOtherMake("Mercedes Benz dealer expands", ["Mercedes Benz"]), false);
  assert.equal(namesOtherMake("A new ram for the farm", ["Subaru"]), false, "lower-case words are not makes");
});

test("brand context is for the U.S. market", () => {
  assert.equal(isForeignMarketStory("BMW recalls nearly 11,000 cars in SA: These are the affected models"), true);
  assert.equal(isForeignMarketStory("Subaru Forester hybrid recalled in Australia"), true);
  assert.equal(isForeignMarketStory("BMW recalls roughly 190,000 older 3, 5 and 7 Series cars over starter relays"), false);
  assert.equal(scoreArticle("BMW recalls nearly 11,000 cars in SA: These are the affected models", [{ keyword: "BMW", kind: "brand" }]).score, 0);
  assert.equal(isForeignPublisher("https://www.caradvice.com.au/1234/forester-recall/"), true);
  assert.equal(isForeignPublisher("https://www.iol.co.za/motoring"), true);
  assert.equal(isForeignPublisher("https://www.caranddriver.com/news", null), false);
  assert.equal(isForeignPublisher("not a url"), false);
});
