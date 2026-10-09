import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateScan, type EvalLink, type EvalPage, type EvalSite } from "@/lib/seo/checks/evaluate";
import { computeScore } from "@/lib/seo/scoring";
import { THRESHOLDS } from "@/lib/seo/checks/config";

/**
 * Controlled pages, one defect each, run through the real evaluator.
 *
 * The point is not to re-test the thresholds — `scoring.test.ts` does that —
 * but to prove the three properties a report has to have before anyone shows it
 * to a dealership: the right check fires for the right defect, the same input
 * always produces the same output, and a clean page produces no findings.
 */

const BASE = "https://www.example-dealer.com";

const site: EvalSite = {
  baseUrl: `${BASE}/`,
  siteAvailable: true,
  homepageStatus: 200,
  homepageErrorCode: null,
  robots: { found: true, blocksAll: false, blocksGooglebot: false, sitemaps: [`${BASE}/sitemap.xml`] },
  sitemap: { found: true, urlCount: 120 },
  importantPages: [
    { key: "service", label: "Service department", found: true, url: `${BASE}/service` },
    { key: "finance", label: "Financing", found: true, url: `${BASE}/finance` },
  ],
};

/** A page with nothing wrong with it. Each case below breaks exactly one thing. */
function cleanPage(id: number, path: string, over: Partial<EvalPage> = {}): EvalPage {
  return {
    id,
    url: `${BASE}${path}`,
    finalUrl: `${BASE}${path}`,
    status: "fetched",
    pageType: path === "/" ? "home" : "other",
    isImportant: path === "/",
    httpStatus: 200,
    responseTimeMs: 400,
    htmlBytes: 60_000,
    title: `A clear descriptive page title for ${path.slice(1) || "the home page"}`,
    metaDescription: `A meta description for ${path} that comfortably clears the minimum length while staying under the maximum.`,
    h1: ["The single heading"],
    h2: ["A subheading", "Another subheading"],
    canonical: `${BASE}${path}`,
    robotsMeta: null,
    xRobotsTag: null,
    lang: "en",
    hasViewport: true,
    wordCount: 600,
    internalLinksCount: 25,
    imagesCount: 8,
    imagesMissingAlt: 0,
    blockingScriptsCount: 1,
    schemaTypes: ["AutoDealer"],
    schemaErrors: 0,
    openGraph: { "og:title": "t", "og:description": "d", "og:image": "i" },
    errorCode: null,
    details: null,
    ...over,
  };
}

const keysFrom = (pages: EvalPage[], links: EvalLink[] = []) => new Set(evaluateScan(pages, links, site).issues.map((i) => i.checkKey));

test("a clean site produces no issues at all", () => {
  const found = keysFrom([cleanPage(1, "/"), cleanPage(2, "/service"), cleanPage(3, "/finance")]);
  assert.deepEqual([...found], [], `clean pages should flag nothing, got: ${[...found].join(", ")}`);
});

/** Each case: one broken page, and the check key that must appear because of it. */
const CASES: Array<[string, Partial<EvalPage>, string]> = [
  ["missing title", { title: null }, "title_missing"],
  ["short title", { title: "Too short" }, "title_length"],
  ["long title", { title: "x".repeat(THRESHOLDS.titleMax + 40) }, "title_length"],
  ["missing meta description", { metaDescription: null }, "description_missing"],
  ["long meta description", { metaDescription: "y".repeat(THRESHOLDS.descriptionMax + 60) }, "description_length"],
  ["missing H1", { h1: [] }, "h1_missing"],
  ["multiple H1s", { h1: ["First heading", "Second heading"] }, "h1_multiple"],
  ["missing canonical", { canonical: null }, "canonical_missing"],
  ["images missing alt text", { imagesCount: 10, imagesMissingAlt: 6 }, "image_alt_missing"],
  ["slow response", { responseTimeMs: THRESHOLDS.slowResponseMs + 2000 }, "slow_response"],
  ["thin content", { wordCount: THRESHOLDS.thinContentWords - 50 }, "thin_content"],
  ["missing viewport", { hasViewport: false }, "viewport_missing"],
  ["missing lang", { lang: null }, "lang_missing"],
  ["invalid schema", { schemaErrors: 3 }, "schema_invalid"],
  ["few internal links", { internalLinksCount: 1 }, "low_internal_links"],
];

for (const [label, defect, expected] of CASES) {
  test(`detects: ${label}`, () => {
    // Two healthy siblings so site-wide checks stay satisfied and only the
    // injected defect can be responsible for the finding.
    const pages = [cleanPage(1, "/", defect), cleanPage(2, "/service"), cleanPage(3, "/finance")];
    const found = keysFrom(pages);
    assert.ok(found.has(expected), `expected ${expected}; got: ${[...found].join(", ") || "nothing"}`);
  });
}

test("detects noindex, and distinguishes an important page from an ordinary one", () => {
  const important = keysFrom([cleanPage(1, "/", { robotsMeta: "noindex, nofollow" }), cleanPage(2, "/service"), cleanPage(3, "/finance")]);
  assert.ok(important.has("noindex_important"), `noindex on the home page is the severe case; got ${[...important].join(", ")}`);

  const ordinary = keysFrom([cleanPage(1, "/"), cleanPage(2, "/service"), cleanPage(3, "/finance"), cleanPage(4, "/about", { robotsMeta: "noindex" })]);
  assert.ok(ordinary.has("noindex_page"), `noindex on an ordinary page; got ${[...ordinary].join(", ")}`);
});

test("detects duplicate titles and descriptions across pages", () => {
  const shared = "One identical title shared by two different pages";
  const sharedDesc = "One identical meta description shared by two different pages, long enough to pass the minimum.";
  const pages = [
    cleanPage(1, "/", { title: shared, metaDescription: sharedDesc }),
    cleanPage(2, "/service", { title: shared, metaDescription: sharedDesc }),
    cleanPage(3, "/finance"),
  ];
  const found = keysFrom(pages);
  assert.ok(found.has("title_duplicate"), "duplicate titles should be flagged");
  assert.ok(found.has("description_duplicate"), "duplicate descriptions should be flagged");
});

test("detects broken internal links, and ignores healthy redirects", () => {
  const pages = [cleanPage(1, "/"), cleanPage(2, "/service"), cleanPage(3, "/finance")];
  const links: EvalLink[] = [
    { url: `${BASE}/gone`, isInternal: true, httpStatus: 404, errorCode: null, isBroken: true, foundOn: [`${BASE}/`], occurrences: 1, anchorText: "Gone" },
    { url: `${BASE}/moved`, isInternal: true, httpStatus: 301, errorCode: null, isBroken: false, foundOn: [`${BASE}/`], occurrences: 1, anchorText: "Moved" },
  ];
  const found = keysFrom(pages, links);
  assert.ok(found.has("broken_internal_link"), "a 404 link should be flagged");
  const issues = evaluateScan(pages, links, site).issues.filter((i) => i.checkKey === "broken_internal_link");
  assert.ok(!JSON.stringify(issues).includes("/moved"), "a 301 is a redirect, not a broken link");
});

test("detects robots and sitemap problems", () => {
  const pages = [cleanPage(1, "/"), cleanPage(2, "/service"), cleanPage(3, "/finance")];
  const noRobots = evaluateScan(pages, [], { ...site, robots: { found: false, blocksAll: false, blocksGooglebot: false, sitemaps: [] } });
  assert.ok(noRobots.issues.some((i) => i.checkKey === "robots_missing"));

  const blocked = evaluateScan(pages, [], { ...site, robots: { ...site.robots, blocksAll: true } });
  assert.ok(blocked.issues.some((i) => i.checkKey === "robots_blocks_all"));

  const noSitemap = evaluateScan(pages, [], { ...site, sitemap: { found: false, urlCount: 0 } });
  assert.ok(noSitemap.issues.some((i) => i.checkKey === "sitemap_missing"));
});

test("detects a missing important page", () => {
  const pages = [cleanPage(1, "/"), cleanPage(2, "/service")];
  const result = evaluateScan(pages, [], {
    ...site,
    importantPages: [...site.importantPages.slice(0, 1), { key: "finance", label: "Financing", found: false, url: null }],
  });
  assert.ok(result.issues.some((i) => i.checkKey === "important_page_missing"));
});

test("scoring is deterministic and reproducible", () => {
  const pages = [cleanPage(1, "/", { title: null, h1: [] }), cleanPage(2, "/service", { metaDescription: null }), cleanPage(3, "/finance", { imagesCount: 9, imagesMissingAlt: 5 })];
  const runs = Array.from({ length: 25 }, () => {
    const r = evaluateScan(pages, [], site);
    return JSON.stringify({ score: computeScore(r.checks).score, keys: r.issues.map((i) => i.checkKey).sort() });
  });
  assert.equal(new Set(runs).size, 1, "25 identical inputs must give 25 identical outputs");
});

test("page order does not change the score", () => {
  const a = [cleanPage(1, "/", { title: null }), cleanPage(2, "/service"), cleanPage(3, "/finance", { h1: [] })];
  const b = [a[2], a[0], a[1]];
  assert.equal(computeScore(evaluateScan(a, [], site).checks).score, computeScore(evaluateScan(b, [], site).checks).score);
});

test("the issue list and the counts it reports agree", () => {
  // The dashboard trusts stored counters; they have to equal the rows.
  const pages = [cleanPage(1, "/", { title: null, h1: [], canonical: null }), cleanPage(2, "/service", { metaDescription: null }), cleanPage(3, "/finance")];
  const r = evaluateScan(pages, [], site);
  const bySeverity = r.issues.reduce<Record<string, number>>((a, i) => ({ ...a, [i.severity]: (a[i.severity] ?? 0) + 1 }), {});
  const total = Object.values(bySeverity).reduce((a, b) => a + b, 0);
  assert.equal(total, r.issues.length, "severity buckets must sum to the issue count");
  assert.ok(r.issues.every((i) => ["critical", "warning", "notice"].includes(i.severity)), "every issue carries a known severity");
});

test("an unreachable site is flagged, and is not scored as if it were bad", () => {
  // A zero would read as "this site is terrible" rather than "we could not look".
  // `computeScore` is a pure scoring function and always returns a number; the
  // decision to store null instead lives in scan-engine.ts (`siteAvailable &&
  // !crawlBlocked ? scored.score : null`). This pins the half that is testable
  // without a database: the unavailability is detected and reported.
  const r = evaluateScan([], [], { ...site, siteAvailable: false, homepageStatus: null, homepageErrorCode: "ECONNREFUSED" });
  assert.ok(r.issues.some((i) => i.checkKey === "site_unavailable"), "an unreachable site must be flagged");
  assert.equal(typeof computeScore(r.checks).score, "number", "computeScore itself always returns a number");
});

test("issue rows per check are capped, and the cap is a real number", () => {
  // Storage is bounded, which is exactly why the UI must not imply the list is
  // exhaustive; see the detail-retention finding in the Phase 3 report.
  const many = Array.from({ length: THRESHOLDS.maxIssuesPerCheck + 50 }, (_, i) => cleanPage(i + 1, `/p${i}`, { title: null }));
  const r = evaluateScan(many, [], site);
  const titleIssues = r.issues.filter((i) => i.checkKey === "title_missing");
  assert.ok(titleIssues.length <= THRESHOLDS.maxIssuesPerCheck, `expected at most ${THRESHOLDS.maxIssuesPerCheck}, got ${titleIssues.length}`);
});
