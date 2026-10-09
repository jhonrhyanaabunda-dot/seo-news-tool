import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CHECKS_BY_KEY } from "@/lib/seo/checks/config";
import { PRIORITY_ORDER, REPORT_GROUPS, priorityFor, reportGroupFor } from "@/lib/seo/priority";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/**
 * Phase 4A is a presentation layer over data that already exists. The risk is
 * therefore not that a calculation is wrong but that a *second* calculation
 * appears, drifts from the report, and shows a dealership a different number
 * from the one in their PDF. These tests pin the reuse.
 */

test("the dashboard does not compute its own score", () => {
  const src = read("src/lib/queries/client-dashboard.ts");
  assert.ok(!src.includes("computeScore"), "score must be read from the scan row, never recalculated");
  assert.ok(/score: latest\.score/.test(src), "score comes straight off seo_scans");
  assert.ok(/scoreDelta: change\?\.scoreDelta/.test(src), "the delta comes from the stored change summary");
});

test("issue counts are read from the stored counters, not recounted", () => {
  // The counters survive detail pruning; recounting rows would silently drop to
  // zero on older scans.
  const src = read("src/lib/queries/client-dashboard.ts");
  assert.ok(/critical: latest\.criticalCount/.test(src));
  assert.ok(/warning: latest\.warningCount/.test(src));
});

test("the dashboard reuses the report's priority and wording", () => {
  // Phase 4C moved this into the shared opportunity module, which the dashboard
  // now consumes; the reuse requirement is unchanged, only its home.
  // The opportunity layer is two modules: the pure shape and comparator, and
  // the query that fills it from a scan. The reuse requirement spans both.
  const src = read("src/lib/queries/client-opportunities.ts") + read("src/lib/seo/opportunity.ts");
  for (const symbol of ["priorityFor", "CHECKS_BY_KEY", "REPORT_GROUPS", "reportGroupFor", "PRIORITY_ORDER"]) {
    assert.ok(src.includes(symbol), `${symbol} must be reused rather than reimplemented`);
  }
  assert.ok(read("src/lib/queries/client-dashboard.ts").includes("getOpportunities"), "the dashboard must consume that module, not its own copy");
});

test("every check can supply client-facing copy for an issue row", () => {
  // The dashboard shows `problem`, `description` and `recommendation` verbatim.
  // A check missing any of them would render a blank row.
  const missing = Object.values(CHECKS_BY_KEY).filter((c) => !c.problem || !c.description || !c.recommendation);
  assert.deepEqual(
    missing.map((c) => c.key),
    [],
    "every check needs a problem, description and recommendation",
  );
});

test("priority ordering puts critical work first", () => {
  const keys = ["low_internal_links", "title_missing", "description_missing", "canonical_missing"];
  const sorted = keys
    .map((k) => ({ k, p: priorityFor(k) }))
    .sort((a, b) => PRIORITY_ORDER[a.p] - PRIORITY_ORDER[b.p])
    .map((x) => x.k);
  assert.equal(sorted[0], "title_missing", "a missing title is the most urgent of these");
  assert.equal(sorted[sorted.length - 1], "low_internal_links");
});

test("every check maps to a business group with a readable label", () => {
  for (const key of Object.keys(CHECKS_BY_KEY)) {
    const label = REPORT_GROUPS[reportGroupFor(key)];
    assert.ok(label && label.length > 2, `${key} must map to a named group`);
  }
});

test("page health counts each page once, by its worst finding", () => {
  const src = read("src/lib/queries/client-dashboard.ts");
  // A page with both a critical and a warning must not appear in both buckets.
  assert.ok(/max\(case when i\.severity = 'critical' then 2/.test(src), "severity is collapsed to a single worst value per page");
  assert.ok(/group by p\.id/.test(src), "grouped per page");
  // Blocked pages are an access restriction, not an SEO fault.
  assert.ok(/'BLOCKED', 'NOT_EVALUATED', 'SKIPPED'/.test(src), "unreachable pages are reported separately");
});

test("the trend is ordered oldest-first and drops unscored scans", () => {
  const src = read("src/lib/queries/client-dashboard.ts");
  assert.ok(/score\} is not null/.test(src), "unscored scans must not appear as gaps or zeroes");
  assert.ok(/trendRows\.reverse\(\)/.test(src), "query is newest-first; the chart reads oldest-first");
});

test("nothing is fabricated when data is absent", () => {
  const src = read("src/lib/queries/client-dashboard.ts");
  // No placeholder score, no invented previous value, no seeded history.
  assert.ok(!/score:\s*\d+/.test(src), "no hard-coded score anywhere");
  assert.ok(!/Math\.random|faker|lorem|demoData|sampleData/i.test(src), "no generated or demo data");
  assert.ok(src.includes("scan: null"), "no scan means no scan, not a zero");
});

test("the view never invents a comparison or a trend", () => {
  const view = read("src/components/client-dashboard.tsx");
  assert.ok(view.includes("No previous score to compare against"), "absent delta is stated, not filled in");
  assert.ok(view.includes("Not enough history yet"), "a short history gets an honest empty state");
  assert.ok(!/Math\.random|faker|placeholder/i.test(view));
});

test("an empty dashboard reads as reassurance, not as an error", () => {
  const view = read("src/components/client-dashboard.tsx");
  assert.ok(view.includes("Nothing needs attention right now"));
  assert.ok(view.includes("You're all caught up"));
  assert.ok(!/No data(?![a-z])/.test(view), "'No data' is never an acceptable empty state here");
});

test("a pruned scan is disclosed rather than shown as a clean site", () => {
  // Same rule as the Phase 3 fix: counts without detail must say so.
  const view = read("src/components/client-dashboard.tsx");
  assert.ok(view.includes("DetailsPrunedNotice"), "must reuse the Phase 3 notice");
  assert.ok(/!scan\.detailsRetained && counts\.critical \+ counts\.warning > 0/.test(view), "only when counts exist without detail");
});

test("client logins are kept off the staff surfaces", () => {
  const page = read("src/app/(app)/dealerships/[id]/page.tsx");
  // The tab list is filtered *and* the parser is restricted, so typing
  // ?tab=pages into the URL does not render a staff surface.
  assert.ok(/const CLIENT_TABS = \["overview", "opportunities", "issues", "news", "reports"\]/.test(page));
  assert.ok(/isClient\(user\) \? CLIENT_TABS : STAFF_TABS/.test(page), "the parser must be restricted, not just the links");
  assert.ok(page.includes('.filter((t) => !isClient(user)'), "the tab links must be filtered too");
});

test("the staff portfolio view is still the staff landing page", () => {
  const home = read("src/app/(app)/(home)/page.tsx");
  assert.ok(home.includes("if (isClient(user)) return <ClientLanding"), "only clients are diverted");
  assert.ok(home.includes("DealershipTable"), "the fleet table must remain for staff");
  assert.ok(home.includes("getDealerRows(allowed)"), "and must stay tenant-scoped");
});

test("the client landing respects tenancy and handles an unassigned account", () => {
  const home = read("src/app/(app)/(home)/page.tsx");
  assert.ok(home.includes("accessibleDealershipIds(user)"), "the allow-list comes from the session");
  assert.ok(home.includes("No website assigned yet"), "an unprovisioned client gets an explanation, not an error");
  assert.ok(/allowed\.length === 1/.test(home) && /getClientDashboard\(allowed\[0\]\)/.test(home), "single-dealership clients land on their dashboard");
});

test("manual scanning keeps its existing guard and rate limit", () => {
  const home = read("src/app/(app)/(home)/page.tsx");
  assert.ok(home.includes("scanNowAction"), "reuses the existing action rather than a new endpoint");
  const action = read("src/app/actions/dealerships.ts");
  const fn = action.slice(action.indexOf("export async function scanNowAction"));
  const body = fn.slice(0, fn.indexOf("\n}\n"));
  assert.ok(body.includes("assertDealershipAccess(id)"), "authorisation unchanged");
  assert.ok(body.includes("checkRateLimit"), "rate limit unchanged");
});
