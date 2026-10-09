import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareOpportunities, countByPriority, scopeLabel, type Opportunity } from "@/lib/seo/opportunity";
import { CHECKS_BY_KEY } from "@/lib/seo/checks/config";
import { PRIORITY_ORDER, REPORT_GROUPS, priorityFor, reportGroupFor } from "@/lib/seo/priority";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/**
 * Phase 4C is a presentation layer, so the risk is the same as 4A: a second
 * definition appearing and drifting. These pin that one ordered list feeds the
 * dashboard, the opportunities page and — later — the report.
 */

function make(over: Partial<Opportunity> = {}): Opportunity {
  return {
    checkKey: "title_missing",
    title: "Missing page titles",
    priority: "CRITICAL",
    group: "metadata",
    groupLabel: "Metadata",
    why: "why",
    action: "action",
    severity: "critical",
    scope: "page",
    affectedPages: 3,
    findings: 3,
    ...over,
  };
}

/** The very comparator getOpportunities uses, applied to fixtures. */
const order = (list: Opportunity[]) => [...list].sort(compareOpportunities);

test("priority ordering is CRITICAL > HIGH > MEDIUM > LOW", () => {
  const list = order([
    make({ checkKey: "a", priority: "LOW" }),
    make({ checkKey: "b", priority: "HIGH" }),
    make({ checkKey: "c", priority: "MEDIUM" }),
    make({ checkKey: "d", priority: "CRITICAL" }),
  ]);
  assert.deepEqual(list.map((o) => o.priority), ["CRITICAL", "HIGH", "MEDIUM", "LOW"]);
});

test("within a priority, wider reach comes first", () => {
  const list = order([make({ checkKey: "a", affectedPages: 2 }), make({ checkKey: "b", affectedPages: 40 })]);
  assert.deepEqual(list.map((o) => o.checkKey), ["b", "a"]);
});

test("ordering is stable and never random", () => {
  // Same priority and the same reach: the check key breaks the tie, so two
  // renders of the same scan cannot disagree.
  const list = [make({ checkKey: "zebra", affectedPages: 5 }), make({ checkKey: "alpha", affectedPages: 5 })];
  const runs = Array.from({ length: 20 }, () => order(list).map((o) => o.checkKey).join(","));
  assert.equal(new Set(runs).size, 1);
  assert.deepEqual(order(list).map((o) => o.checkKey), ["alpha", "zebra"]);
});

test("a site-wide finding is never described as a page count", () => {
  // "1 page affected" for a missing sitemap would be an invented number.
  const siteWide = make({ checkKey: "sitemap_missing", scope: "site", affectedPages: null, findings: 1 });
  assert.equal(scopeLabel(siteWide), "Affects the whole website");
  assert.ok(!/page/i.test(scopeLabel(siteWide)));
});

test("page-scoped findings report their real count, singular and plural", () => {
  assert.equal(scopeLabel(make({ affectedPages: 1 })), "1 page affected");
  assert.equal(scopeLabel(make({ affectedPages: 14 })), "14 pages affected");
});

test("a page-scoped finding with no page attached falls back to findings, not zero pages", () => {
  // Link checks attach to the scan rather than a page; "0 pages affected" would
  // read as "nothing is wrong".
  const label = scopeLabel(make({ checkKey: "broken_internal_link", affectedPages: 0, findings: 4 }));
  assert.equal(label, "4 findings");
  assert.ok(!/0 page/.test(label));
});

test("every opportunity carries the catalogue's own wording", () => {
  const src = read("src/lib/queries/client-opportunities.ts");
  assert.ok(/title: def\?\.problem/.test(src), "title is the check's `problem`");
  assert.ok(/why: def\?\.description/.test(src), "impact is the check's `description`");
  assert.ok(/action: def\?\.recommendation/.test(src), "action is the check's `recommendation`");
  assert.ok(/priority: priorityFor\(/.test(src), "priority comes from the existing table");
  assert.ok(/reportGroupFor\(r\.checkKey\)/.test(src), "grouping comes from the existing table");
});

test("no invented impact score or business claim", () => {
  const src = read("src/lib/queries/client-opportunities.ts");
  const view = read("src/components/opportunities-view.tsx");
  for (const [name, text] of [["query", src], ["view", view]] as const) {
    assert.ok(!/impactScore|businessImpact|\/\s*100|score:\s*\d/.test(text), `${name} must not invent a numeric impact`);
    assert.ok(!/increase (leads|traffic|revenue|conversions)/i.test(text), `${name} must not claim an unmeasured business outcome`);
    assert.ok(!/Math\.random/.test(text), `${name} must be deterministic`);
  }
});

test("every check can supply a complete opportunity", () => {
  const incomplete = Object.values(CHECKS_BY_KEY).filter((c) => !c.problem || !c.description || !c.recommendation);
  assert.deepEqual(incomplete.map((c) => c.key), []);
});

test("every check resolves to a known priority and a named group", () => {
  for (const key of Object.keys(CHECKS_BY_KEY)) {
    assert.ok(PRIORITY_ORDER[priorityFor(key)] !== undefined, `${key} must map to a priority`);
    assert.ok(REPORT_GROUPS[reportGroupFor(key)], `${key} must map to a named group`);
  }
});

test("counts by priority add up to the list", () => {
  const list = [make({ priority: "CRITICAL" }), make({ priority: "LOW" }), make({ priority: "LOW" })];
  const c = countByPriority(list);
  assert.deepEqual(c, { CRITICAL: 1, HIGH: 0, MEDIUM: 0, LOW: 2 });
  assert.equal(Object.values(c).reduce((a, b) => a + b, 0), list.length);
});

test("only the selected scan's findings are used", () => {
  const src = read("src/lib/queries/client-opportunities.ts");
  assert.ok(/where\(eq\(seoIssues\.scanId, scanId\)\)/.test(src), "one scan, never a mix across scans");
});

test("resolved findings are not presented as open", () => {
  // `seo_issues` holds the findings of one scan; a resolved issue is simply
  // absent from the next scan's rows, so scoping to the latest scan is what
  // keeps closed items off this page.
  const src = read("src/lib/queries/client-opportunities.ts");
  assert.ok(!/resolved/i.test(src), "no resolved-issue source is mixed in");
  const page = read("src/app/(app)/dealerships/[id]/page.tsx");
  assert.ok(/getOpportunities\(latest\.id\)/.test(page), "the page uses the latest completed scan");
});

test("a pruned scan is disclosed rather than shown as a clean site", () => {
  const view = read("src/components/opportunities-view.tsx");
  assert.ok(view.includes("DetailsPrunedNotice"), "must reuse the Phase 3 notice");
  assert.ok(/opportunities\.length === 0 && !detailsRetained && storedIssueTotal > 0/.test(view), "only when counts exist without detail");
  // And the clean-site message must not be reachable in that case.
  const prunedBlock = view.slice(view.indexOf("!detailsRetained && storedIssueTotal > 0"), view.indexOf("You're in good shape"));
  assert.ok(prunedBlock.includes("return"), "the pruned branch returns before the empty state");
});

test("the empty state reassures rather than reporting no data", () => {
  const view = read("src/components/opportunities-view.tsx");
  assert.ok(view.includes("You're in good shape"));
  assert.ok(!/No data(?![a-z])/.test(view));
});

test("the dashboard and the opportunities page share one ordered list", () => {
  const dash = read("src/lib/queries/client-dashboard.ts");
  assert.ok(dash.includes("getOpportunities"), "the dashboard calls the shared query");
  assert.ok(/topIssues: opportunities\.slice\(0, TOP_ISSUES\)/.test(dash), "the dashboard shows a prefix of the same list");
  // No second sort in the dashboard would be able to reorder it.
  assert.ok(!/\.sort\(/.test(dash), "the dashboard must not re-sort");
});

test("the dashboard links through to the full list", () => {
  const view = read("src/components/client-dashboard.tsx");
  assert.ok(/tab=opportunities/.test(view), "the summary leads to the action centre");
});

test("priority is not communicated by colour alone", () => {
  const view = read("src/components/opportunities-view.tsx");
  // Each level carries a word as well as a colour, and the list order repeats it.
  for (const label of ["Critical", "High", "Medium", "Low"]) {
    assert.ok(view.includes(`label: "${label}"`), `${label} must have a text label`);
  }
  assert.ok(/priority<\/span>|\{p\.label\} priority/.test(view), "the badge spells out the priority");
});

test("the opportunities tab is inside the tenant-guarded route", () => {
  // The dealership layout performs requireDealershipAccess, so the tab inherits
  // it rather than needing its own check.
  const layout = read("src/app/(app)/dealerships/[id]/layout.tsx");
  assert.ok(layout.includes("requireDealershipAccess"));
  const page = read("src/app/(app)/dealerships/[id]/page.tsx");
  assert.ok(/CLIENT_TABS = \["overview", "opportunities"/.test(page), "clients may reach it");
  assert.ok(/isClient\(user\) \? CLIENT_TABS : STAFF_TABS/.test(page), "and the parser is still restricted");
});
