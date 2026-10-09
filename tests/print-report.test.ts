import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildExecutiveSummary, type SummaryFacts } from "@/lib/reports/print-summary";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const REPORT = "src/app/report/[id]/page.tsx";

/**
 * The executive summary is prose generated from numbers, which is exactly where
 * a report starts lying: a sentence that survives when its value does not. Each
 * test here removes a fact and asserts the sentence disappears with it.
 */

function facts(over: Partial<SummaryFacts> = {}): SummaryFacts {
  return {
    score: 87,
    previousScore: 82,
    scoreDelta: 5,
    critical: 3,
    warning: 8,
    pagesScanned: 124,
    pagesHealthy: 113,
    pagesNotEvaluated: 0,
    opportunityCount: 6,
    topPriority: "HIGH",
    siteAvailable: true,
    detailsRetained: true,
    ...over,
  };
}
const text = (f: SummaryFacts) => buildExecutiveSummary(f).join(" ");

test("the summary states the real score and the real change", () => {
  const t = text(facts());
  assert.match(t, /87 out of 100/);
  assert.match(t, /up 5 points from 82/);
  assert.match(t, /3 critical findings and 8 warnings/);
  assert.match(t, /124 monitored pages/);
});

test("a missing previous score produces no comparison, not a zero", () => {
  const t = text(facts({ previousScore: null, scoreDelta: null }));
  assert.match(t, /first scored check/i);
  assert.ok(!/up 0|down 0|unchanged/.test(t), "must not imply a comparison that does not exist");
});

test("an unchanged score says so rather than reporting a direction", () => {
  const t = text(facts({ scoreDelta: 0, previousScore: 87 }));
  assert.match(t, /unchanged from the previous check/);
  assert.ok(!/\bup\b|\bdown\b/.test(t));
});

test("a drop is reported as a drop", () => {
  assert.match(text(facts({ scoreDelta: -3, previousScore: 90 })), /down 3 points from 90/);
});

test("singular and plural are handled", () => {
  assert.match(text(facts({ scoreDelta: 1, previousScore: 86 })), /up 1 point from/);
  assert.match(text(facts({ critical: 1, warning: 0, pagesScanned: 1 })), /1 critical finding .*1 monitored page/);
});

test("a clean scan reads as clean, not as empty", () => {
  const t = text(facts({ critical: 0, warning: 0, opportunityCount: 0, topPriority: null }));
  assert.match(t, /No critical findings or warnings were recorded/);
  assert.match(t, /No improvement opportunities are open/);
});

test("an unreachable site produces no score narrative at all", () => {
  const t = text(facts({ siteAvailable: false, score: null }));
  assert.match(t, /could not be reached/);
  assert.ok(!/out of 100/.test(t), "no score sentence when there is no score");
  assert.equal(buildExecutiveSummary(facts({ siteAvailable: false, score: null })).length, 1, "it stops rather than padding");
});

test("a pruned scan keeps its totals and says the detail is gone", () => {
  const t = text(facts({ detailsRetained: false }));
  assert.match(t, /3 critical findings and 8 warnings/, "totals survive pruning and must still be stated");
  assert.match(t, /no longer retained/);
  assert.ok(!/improvement opportunit/.test(t), "must not claim opportunities it cannot list");
});

test("blocked pages are explained rather than counted as faults", () => {
  const t = text(facts({ pagesNotEvaluated: 7 }));
  assert.match(t, /7 pages could not be analysed/);
  assert.match(t, /access restrictions rather than SEO problems/);
});

test("the summary never claims an unmeasured business outcome", () => {
  const src = read("src/lib/reports/print-summary.ts");
  for (const claim of [/traffic/i, /ranking/i, /conversion/i, /revenue/i, /\blead(s)?\b/i]) {
    assert.ok(!claim.test(src.replace(/\/\*[\s\S]*?\*\//g, "")), `must not mention ${claim}`);
  }
  assert.ok(!/Math\.random/.test(src));
});

/** The report reuses the dashboard and opportunity layers rather than its own. */
test("the report reads the same sources as the dashboard", () => {
  const src = read(REPORT);
  assert.ok(src.includes("getClientDashboard"), "score, counts and page health come from the dashboard query");
  assert.ok(src.includes("getOpportunities"), "opportunities come from the 4C layer");
  assert.ok(!/computeScore|\.sort\(/.test(src), "the report must not recompute or re-order anything");
});

test("opportunity ordering and wording are not re-derived", () => {
  const src = read(REPORT);
  assert.ok(/opportunities\.slice\(0, MAX_OPPORTUNITIES\)/.test(src), "a prefix of the shared ordered list");
  assert.ok(src.includes("scopeLabel"), "scope wording is shared with the opportunities page");
  assert.ok(src.includes("countByPriority"), "priority counts are shared");
});

test("omitted opportunities are disclosed, never implied away", () => {
  const src = read(REPORT);
  const flat = src.replace(/\s+/g, " ");
  assert.ok(flat.includes("opportunities.length > shown.length"), "the overflow case is handled");
  assert.ok(/further/.test(flat) && /open and available in the A3/.test(flat), "and says the rest exist in the dashboard");
});

test("a pruned scan is disclosed in the report body", () => {
  const src = read(REPORT);
  assert.ok(/!scan\.detailsRetained && counts\.critical \+ counts\.warning > 0/.test(src));
  assert.ok(/no longer stored and cannot be listed/.test(src), "says what is missing and why");
});

test("the trend is only drawn when there is real history", () => {
  const src = read(REPORT);
  assert.ok(/data\.trend\.length > 1 \?/.test(src), "one point is not a trend");
  assert.ok(/not yet enough history/.test(src), "and the absence is explained");
});

test("the report is tenant-guarded like every other dealership surface", () => {
  const src = read(REPORT);
  assert.ok(src.includes("requireDealershipAccess(dealershipId)"), "same guard as dashboard and opportunities");
  assert.ok(src.includes("canAccessDealership"), "metadata must not leak the dealership name either");
});

test("no raw scanner output or internal identifiers reach the document", () => {
  const src = read(REPORT);
  // Alerts carry URL lists and were deliberately kept out; ids are internal.
  assert.ok(!/data\.activity/.test(src), "recent-activity messages are not reproduced in the report");
  assert.ok(!/scan\.id\}|report-id|dealershipId\}/.test(src.replace(/getOpportunities\(scan\.id\)/g, "")), "no internal ids printed");
});

test("the print stylesheet controls page breaks", () => {
  const css = read("src/app/globals.css");
  const print = css.slice(css.indexOf("/* ───────────────────────── Printed SEO report"));
  for (const rule of ["@page", "break-after: avoid", "break-inside: avoid", "display: table-header-group", "orphans: 3", "widows: 3"]) {
    assert.ok(print.includes(rule), `print CSS must set ${rule}`);
  }
  assert.ok(print.includes("overflow-wrap: anywhere"), "long URLs and titles must wrap rather than overflow");
});

test("priority is legible without colour", () => {
  const src = read(REPORT);
  // Each opportunity is numbered and spells out its priority word.
  assert.ok(/doc-opp-n/.test(src) && /o\.priority\.charAt\(0\) \+ o\.priority\.slice\(1\)\.toLowerCase\(\)/.test(src));
  const css = read("src/app/globals.css");
  assert.ok(css.includes("The word carries the priority"), "colour is documented as secondary");
});
