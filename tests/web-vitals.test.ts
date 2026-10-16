import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePageSpeedResponse, performanceSnapshotDue, pickPerformanceTargets, ratePerformanceScore, rateVital, SNAPSHOT_RETRY_HOURS } from "@/lib/seo/web-vitals";

/**
 * Core Web Vitals snapshots: Google's thresholds, PageSpeed response parsing,
 * the weekly schedule, and the guarantee that none of it touches the score.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("ratings use Google's thresholds, inclusive at the boundary", () => {
  assert.equal(rateVital("lcpMs", 2500), "good");
  assert.equal(rateVital("lcpMs", 2501), "needs_improvement");
  assert.equal(rateVital("lcpMs", 4000), "needs_improvement");
  assert.equal(rateVital("lcpMs", 4001), "poor");
  assert.equal(rateVital("inpMs", 200), "good");
  assert.equal(rateVital("inpMs", 350), "needs_improvement");
  assert.equal(rateVital("inpMs", 501), "poor");
  assert.equal(rateVital("cls", 0.1), "good");
  assert.equal(rateVital("cls", 0.25), "needs_improvement");
  assert.equal(rateVital("cls", 0.26), "poor");
  assert.equal(rateVital("cls", null), null);
  assert.equal(ratePerformanceScore(90), "good");
  assert.equal(ratePerformanceScore(49), "poor");
});

const PSI = {
  lighthouseResult: {
    categories: { performance: { score: 0.43 } },
    audits: {
      "largest-contentful-paint": { numericValue: 5234.6 },
      "cumulative-layout-shift": { numericValue: 0.18234 },
      "total-blocking-time": { numericValue: 812.2 },
      "first-contentful-paint": { numericValue: 2100.4 },
    },
  },
  loadingExperience: {
    metrics: {
      LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3100, category: "AVERAGE" },
      INTERACTION_TO_NEXT_PAINT: { percentile: 180, category: "FAST" },
      CUMULATIVE_LAYOUT_SHIFT_SCORE: { percentile: 27, category: "SLOW" },
    },
    overall_category: "SLOW",
  },
};

test("lab and field metrics are parsed from a PageSpeed Insights response", () => {
  const r = parsePageSpeedResponse(PSI, "mobile");
  assert.deepEqual(
    { performance: r.performance, lcpMs: r.lcpMs, cls: r.cls, tbtMs: r.tbtMs, fcpMs: r.fcpMs },
    { performance: 43, lcpMs: 5235, cls: 0.182, tbtMs: 812, fcpMs: 2100 },
  );
  assert.deepEqual(r.field, { scope: "url", lcpMs: 3100, lcpCategory: "needs_improvement", inpMs: 180, inpCategory: "good", cls: 0.27, clsCategory: "poor", overall: "poor" }, "CrUX CLS is reported ×100");
});

test("field data falls back to the origin, labelled as such, and is null when Google has none", () => {
  const origin = parsePageSpeedResponse({ ...PSI, loadingExperience: { ...PSI.loadingExperience, origin_fallback: true } }, "mobile");
  assert.equal(origin.field?.scope, "origin");
  const onlyOrigin = parsePageSpeedResponse({ lighthouseResult: PSI.lighthouseResult, originLoadingExperience: PSI.loadingExperience }, "mobile");
  assert.equal(onlyOrigin.field?.scope, "origin");
  const none = parsePageSpeedResponse({ lighthouseResult: PSI.lighthouseResult, loadingExperience: {} }, "mobile");
  assert.equal(none.field, null, "a small dealership often has no CrUX data; that is not an error");
  assert.equal(parsePageSpeedResponse({}, "mobile").performance, null);
});

test("snapshots are due at most once per interval, from stored timestamps only", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const days = (n: number) => new Date(now.getTime() - n * 86_400_000);
  assert.equal(performanceSnapshotDue({ successAt: null, attemptAt: null }, now), true, "never measured");
  assert.equal(performanceSnapshotDue({ successAt: days(6.9), attemptAt: days(6.9) }, now), false);
  assert.equal(performanceSnapshotDue({ successAt: days(7), attemptAt: days(7) }, now), true);
  // A failed attempt (API error) waits a day, so a bad key never becomes a retry loop.
  assert.equal(performanceSnapshotDue({ successAt: days(30), attemptAt: new Date(now.getTime() - (SNAPSHOT_RETRY_HOURS - 1) * 3_600_000) }, now), false);
  assert.equal(performanceSnapshotDue({ successAt: days(30), attemptAt: days(2) }, now), true);
  assert.equal(performanceSnapshotDue({ successAt: null, attemptAt: null }, now, 0), false, "PERFORMANCE_SNAPSHOT_DAYS=0 turns snapshots off");
});

test("targets: the homepage and the first crawled vehicle page, deterministically", () => {
  const pages = [
    { id: 9, url: "https://d.com/vdp/b", finalUrl: null, pageType: "vehicle_detail", ok: true, confirmedVdp: true },
    { id: 4, url: "https://d.com/vdp/a", finalUrl: "https://d.com/vdp/a/", pageType: "vehicle_detail", ok: true, confirmedVdp: true },
    { id: 2, url: "https://d.com/inventory/new/x", finalUrl: null, pageType: "vehicle_detail", ok: true, confirmedVdp: false },
    { id: 1, url: "http://d.com", finalUrl: "https://d.com/", pageType: "home", ok: true, confirmedVdp: false },
  ];
  assert.deepEqual(pickPerformanceTargets(pages), [{ url: "https://d.com/", kind: "home" }, { url: "https://d.com/vdp/a/", kind: "vdp" }]);
  assert.deepEqual(pickPerformanceTargets(pages.map((p) => ({ ...p, ok: p.pageType === "home" }))), [{ url: "https://d.com/", kind: "home" }], "no VDP crawled: homepage only");
  assert.deepEqual(pickPerformanceTargets([]), []);
});

test("Core Web Vitals never feed the score, and degrade gracefully without an API key", () => {
  for (const f of ["src/lib/seo/scoring.ts", "src/lib/seo/checks/evaluate.ts"]) assert.ok(!/performance_snapshots|performanceSnapshots|web-vitals|pagespeed/i.test(read(f)), `${f} must not read speed data`);
  const job = read("src/lib/seo/performance-job.ts");
  assert.ok(/if \(!pageSpeedEnabled\(\) \|\| !input\.targets\.length\) return null;/.test(job), "nothing is queued without PAGESPEED_API_KEY");
  assert.ok(job.includes("dedupeKey: `performance:${input.dealershipId}`"), "one queued snapshot per dealership");
  assert.ok((job.match(/performanceSnapshotDue\(/g) ?? []).length >= 2, "due-ness is checked when queuing and again when the job runs");
  const runner = read("src/lib/jobs/runner.ts");
  assert.ok(runner.includes('"performance_snapshot"') && runner.includes('case "performance_snapshot"'), "the job type is claimed and handled");
  assert.ok(!/BROWSER_TYPES: JobType\[\] = \[[^\]]*performance_snapshot/.test(runner), "Google runs Lighthouse, so no browser is needed");
  const engine = read("src/lib/seo/scan-engine.ts");
  assert.ok(/if \(siteAvailable && !crawlBlocked\) \{\s*try \{\s*const targets = pickPerformanceTargets/.test(engine), "only completed, directly crawled scans queue a snapshot");
  assert.ok(read("src/lib/db/schema.ts").includes('"report_pdf", "performance_snapshot"]'), "job type enum");
});
