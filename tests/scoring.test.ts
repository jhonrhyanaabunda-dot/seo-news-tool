import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateScan, type EvalPage, type EvalSite } from "@/lib/seo/checks/evaluate";
import { computeScore } from "@/lib/seo/scoring";

const site: EvalSite = {
  baseUrl: "https://www.example-dealer.com/",
  siteAvailable: true,
  homepageStatus: 200,
  homepageErrorCode: null,
  robots: { found: true, blocksAll: false, blocksGooglebot: false, sitemaps: ["https://www.example-dealer.com/sitemap.xml"] },
  sitemap: { found: true, urlCount: 120 },
  importantPages: [
    { key: "service", label: "Service department", found: true, url: "https://www.example-dealer.com/service" },
    { key: "finance", label: "Financing", found: true, url: "https://www.example-dealer.com/finance" },
  ],
};

function page(id: number, path: string, over: Partial<EvalPage> = {}): EvalPage {
  return {
    id,
    url: `https://www.example-dealer.com${path}`,
    finalUrl: `https://www.example-dealer.com${path}`,
    status: "fetched",
    pageType: path === "/" ? "home" : "other",
    isImportant: path === "/",
    httpStatus: 200,
    responseTimeMs: 400,
    htmlBytes: 80_000,
    title: `A good descriptive title for page ${id} here`,
    metaDescription: `A meta description that is comfortably long enough to pass the length check for page ${id}.`,
    h1: [`Heading ${id}`],
    h2: ["Section"],
    canonical: `https://www.example-dealer.com${path}`,
    robotsMeta: null,
    xRobotsTag: null,
    lang: "en",
    hasViewport: true,
    wordCount: 500,
    internalLinksCount: 20,
    imagesCount: 4,
    imagesMissingAlt: 0,
    blockingScriptsCount: 1,
    schemaTypes: path === "/" ? ["AutoDealer"] : ["WebPage"],
    schemaErrors: 0,
    openGraph: { "og:title": "t", "og:description": "d", "og:image": "i" },
    errorCode: null,
    details: { imagesWithoutDimensions: 0, mixedContentCount: 0 },
    ...over,
  };
}

test("a clean site scores 100 with no issues", () => {
  const pages = [page(1, "/"), page(2, "/service"), page(3, "/finance")];
  const r = evaluateScan(pages, [], site);
  assert.equal(r.issues.length, 0);
  assert.equal(computeScore(r.checks).score, 100);
});

test("scoring is deterministic for identical input", () => {
  const pages = [page(1, "/", { metaDescription: null }), page(2, "/a", { title: null }), page(3, "/b", { imagesMissingAlt: 3 })];
  const a = evaluateScan(pages, [], site);
  const b = evaluateScan(structuredClone(pages), [], structuredClone(site));
  assert.deepEqual(a, b);
  assert.equal(computeScore(a.checks).score, computeScore(b.checks).score);
});

test("issues reduce the score and more widespread issues reduce it more", () => {
  const base = [page(1, "/"), page(2, "/a"), page(3, "/b"), page(4, "/c")];
  const one = base.map((p, i) => (i === 1 ? { ...p, title: null } : p));
  const all = base.map((p) => ({ ...p, title: null }));
  const s1 = computeScore(evaluateScan(one, [], site).checks).score;
  const s2 = computeScore(evaluateScan(all, [], site).checks).score;
  assert.ok(s1 < 100);
  assert.ok(s2 < s1);
});

test("duplicate titles are flagged on every page sharing the title", () => {
  const pages = [page(1, "/", { title: "Same title for both pages ok" }), page(2, "/a", { title: "Same title for both pages ok" }), page(3, "/b")];
  const issues = evaluateScan(pages, [], site).issues.filter((i) => i.checkKey === "title_duplicate");
  assert.equal(issues.length, 2);
});

test("site unavailable produces a critical issue", () => {
  const r = evaluateScan([], [], { ...site, siteAvailable: false, homepageStatus: 503 });
  const issue = r.issues.find((i) => i.checkKey === "site_unavailable");
  assert.ok(issue);
  assert.equal(issue.severity, "critical");
  assert.match(issue.message, /server error/i);
});

test("noindex on an important page is critical", () => {
  const r = evaluateScan([page(1, "/", { robotsMeta: "noindex, nofollow" })], [], site);
  assert.ok(r.issues.some((i) => i.checkKey === "noindex_important" && i.severity === "critical"));
});

test("fingerprints are stable across http/https and trailing slash", async () => {
  const { fingerprint } = await import("@/lib/seo/checks/evaluate");
  assert.equal(fingerprint("title_missing", "https://www.x.com/a/"), fingerprint("title_missing", "http://x.com/a"));
});

test("a broken link keeps its issue identity whether the site writes it with a trailing slash or not", () => {
  const pages = [page(1, "/")];
  const link = (url: string) => ({ url, isInternal: true, httpStatus: 404, errorCode: null, isBroken: true, foundOn: ["https://www.example-dealer.com/"], occurrences: 1, anchorText: "Specials" });
  const withSlash = evaluateScan(pages, [link("https://www.example-dealer.com/specials/")], site).issues.find((i) => i.checkKey === "broken_internal_link");
  const without = evaluateScan(pages, [link("https://www.example-dealer.com/specials")], site).issues.find((i) => i.checkKey === "broken_internal_link");
  assert.ok(withSlash && without);
  assert.equal(withSlash.fingerprint, without.fingerprint);
  assert.match(withSlash.message, /specials\/ —/, "the message names the link exactly as the site wrote it");
});

test("link checks refused by site security are not broken links", async () => {
  const { isBrokenLink } = await import("@/lib/seo/links");
  assert.equal(isBrokenLink(true, 403, null), false);
  assert.equal(isBrokenLink(true, 429, null), false);
  assert.equal(isBrokenLink(true, 404, null), true);
  assert.equal(isBrokenLink(true, 503, null), true);
  assert.equal(isBrokenLink(true, null, "DNS"), true);
  assert.equal(isBrokenLink(false, null, "TIMEOUT"), false);
});

test("a blocked crawl does not report the sitemap as missing", () => {
  const r = evaluateScan([], [], { ...site, sitemap: null, importantPages: [] });
  assert.equal(r.issues.some((i) => i.checkKey.startsWith("sitemap_")), false);
});

test("robots.txt refused by the firewall is not reported as missing", () => {
  const r = evaluateScan([], [], { ...site, robots: { found: false, blocksAll: false, blocksGooglebot: false, sitemaps: [], checked: false }, sitemap: null, importantPages: [] });
  assert.equal(r.issues.some((i) => i.checkKey.startsWith("robots_")), false);
});
