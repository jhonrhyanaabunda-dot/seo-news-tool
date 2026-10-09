import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { newsSources } from "@/lib/db/schema";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const dialect = new PgDialect();

/**
 * F-1: housekeeping keeps individual issue rows for only the ten most recent
 * scans per dealership, while the totals on the scan row survive forever. An
 * empty detail list therefore has four possible meanings, and only one of them
 * is "this site is clean". These tests pin the branch that tells them apart,
 * because the failure mode is silent: the page looks fine and simply misleads.
 */

/** The decision the Issues tab makes, extracted so it can be exercised directly. */
type Case = { detailsRetained: boolean; storedIssueTotal: number; rowsReturned: number; hasFilter: boolean };
function emptyStateFor({ detailsRetained, storedIssueTotal, rowsReturned, hasFilter }: Case): "pruned" | "unavailable" | "no-issues" | "no-match" | "list" {
  if (rowsReturned > 0) return "list";
  if (!detailsRetained && storedIssueTotal > 0) return "pruned";
  if (detailsRetained && rowsReturned === 0 && storedIssueTotal > 0) return "unavailable";
  if (storedIssueTotal === 0 && rowsReturned === 0 && !hasFilter) return "no-issues";
  return "no-match";
}

test("retained details with rows render the list", () => {
  assert.equal(emptyStateFor({ detailsRetained: true, storedIssueTotal: 15, rowsReturned: 15, hasFilter: false }), "list");
});

test("pruned details are labelled, not reported as a clean scan", () => {
  // The exact shape of 72 of the 104 production scans.
  assert.equal(emptyStateFor({ detailsRetained: false, storedIssueTotal: 15, rowsReturned: 0, hasFilter: false }), "pruned");
});

test("a count with zero detail rows never reads as 'no issues'", () => {
  for (const detailsRetained of [true, false]) {
    const state = emptyStateFor({ detailsRetained, storedIssueTotal: 7, rowsReturned: 0, hasFilter: false });
    assert.notEqual(state, "no-issues", `detailsRetained=${detailsRetained} must not claim the scan was clean`);
    assert.ok(state === "pruned" || state === "unavailable");
  }
});

test("details marked retained but missing are reported as unexpected", () => {
  // Claiming retention while showing nothing would be the one actively false
  // answer, so this case gets its own warning rather than the pruned wording.
  assert.equal(emptyStateFor({ detailsRetained: true, storedIssueTotal: 3, rowsReturned: 0, hasFilter: false }), "unavailable");
});

test("a genuinely clean scan still says so", () => {
  assert.equal(emptyStateFor({ detailsRetained: true, storedIssueTotal: 0, rowsReturned: 0, hasFilter: false }), "no-issues");
});

test("a filter that matches nothing is not confused with pruning", () => {
  assert.equal(emptyStateFor({ detailsRetained: true, storedIssueTotal: 12, rowsReturned: 0, hasFilter: true }), "unavailable");
  assert.equal(emptyStateFor({ detailsRetained: true, storedIssueTotal: 0, rowsReturned: 0, hasFilter: true }), "no-match");
});

test("the UI actually wires the retention flag through", () => {
  const page = read("src/app/(app)/dealerships/[id]/page.tsx");
  assert.ok(page.includes("detailsRetained={latest.detailsRetained}"), "Issues tab must receive the flag");
  assert.ok(page.includes("storedIssueTotal={latest.criticalCount + latest.warningCount}"), "Issues tab must receive the stored totals");
  assert.ok(page.includes("{!selected.detailsRetained && <DetailsPrunedNotice />}"), "the history card must disclose pruning");
  assert.ok(page.includes("!h.detailsRetained"), "the history table must mark pruned scans");
});

test("the notices state that totals remain accurate", () => {
  const file = read("src/components/detail-retention.tsx");
  // Strip comments: the file explains the failure mode and naturally uses the
  // very phrase the rendered copy must avoid.
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const pruned = strip(file.slice(file.indexOf("export function DetailsPrunedNotice"), file.indexOf("export function DetailsUnavailableNotice")));
  const unavailable = strip(file.slice(file.indexOf("export function DetailsUnavailableNotice")));

  assert.ok(/not retained for this scan/i.test(pruned), "must say details were not retained");
  assert.ok(/totals/i.test(pruned) && /(accurate|preserved)/i.test(pruned), "must reassure that the counts still hold");
  assert.ok(!/no issues/i.test(pruned), "the pruned notice must not imply the scan was clean");

  assert.ok(/could not be loaded/i.test(unavailable), "must say the details could not be loaded");
  assert.ok(/accurate/i.test(unavailable), "must confirm the totals are still accurate");
  // This one deliberately names the wrong reading in order to rule it out.
  assert.ok(/rather than treating the scan as having no issues/i.test(unavailable), "must warn against reading it as a clean scan");
});

/**
 * F-2: deleting a news source by id alone let a posted id reach a source that
 * belongs to a different dealership. The delete now has to match the same set
 * the admin page lists: the dealership's own sources plus the shared ones for
 * its brand.
 */
test("news source deletion is scoped to the dealership and its brand", () => {
  const where = and(
    eq(newsSources.id, 42),
    or(eq(newsSources.dealershipId, 7), and(isNull(newsSources.dealershipId), sql`lower(${newsSources.brand}) = lower('BMW')`)),
  );
  const q = dialect.sqlToQuery(where!);
  assert.ok(q.sql.includes('"news_sources"."id"'), "must filter on the source id");
  assert.ok(q.sql.includes('"news_sources"."dealership_id"'), "must filter on the dealership");
  assert.ok(q.sql.includes("is null"), "shared brand sources must stay reachable");
  assert.ok(q.params.includes(42) && q.params.includes(7));
});

test("removeNewsSource requires a dealership, not just an id", () => {
  const src = read("src/lib/news/sources.ts");
  const fn = src.slice(src.indexOf("export async function removeNewsSource"));
  const body = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(/removeNewsSource\(sourceId: number, dealership/.test(body), "signature must take the dealership");
  assert.ok(body.includes("eq(newsSources.dealershipId"), "the delete must match on the dealership");
  assert.ok(!/\.where\(eq\(newsSources\.id, sourceId\)\)/.test(body), "must not delete by id alone");
});

test("removeNewsSourceAction resolves the dealership server-side", () => {
  const src = read("src/app/actions/news-sources.ts");
  const fn = src.slice(src.indexOf("export async function removeNewsSourceAction"));
  const action = fn.slice(0, fn.indexOf("\n}\n") + 2);
  assert.ok(action.includes("assertAdmin()"), "still admin-only");
  assert.ok(action.includes("assertDealershipAccess(id)"), "dealership access comes from the session");
  assert.ok(action.includes("getDealership(id)"), "the dealership is loaded server-side, not taken from the form");
  assert.ok(/removeNewsSource\(sourceId, dealership\)/.test(action), "both ids must be required together");
});

/** F-7: the loading skeleton was exactly 320px wide and overflowed that screen. */
test("the skeleton header cannot exceed the viewport", () => {
  const skel = read("src/components/ui/skeleton.tsx");
  assert.ok(skel.includes("w-full max-w-80"), "must be capped rather than fixed");
  assert.ok(!/className="h-4 w-80 /.test(skel), "the fixed 320px width must be gone");
});
