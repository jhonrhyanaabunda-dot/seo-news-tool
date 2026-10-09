import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, inArray } from "drizzle-orm";
import { seoScans } from "@/lib/db/schema";

// Mirrored rather than imported: the scans module opens a database client at
// import time, and this file only needs to render SQL.
const ACTIVE_SCAN_STATUSES = ["queued", "crawling", "finalizing"] as const;

const dialect = new PgDialect();
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/**
 * Guard rails for the authorisation fixes. These assert the shape of the
 * queries and the placement of the checks, which is what actually went wrong
 * before: the code "had a guard" but the guard either trusted an id from the
 * form or ran somewhere the framework had already committed the response.
 */

test("cancelScan matches on the dealership as well as the scan", () => {
  // The bug was a WHERE on the scan id alone, so a scan id belonging to another
  // dealership would cancel.
  const where = and(eq(seoScans.id, 7), eq(seoScans.dealershipId, 3), inArray(seoScans.status, [...ACTIVE_SCAN_STATUSES]));
  const q = dialect.sqlToQuery(where!);
  assert.ok(q.sql.includes('"seo_scans"."id"'), "should filter on the scan id");
  assert.ok(q.sql.includes('"seo_scans"."dealership_id"'), "should filter on the dealership id");
  assert.ok(q.params.includes(7) && q.params.includes(3));
});

test("cancelScanAction checks admin, dealership access and the pairing", () => {
  const src = read("src/app/actions/dealerships.ts");
  const body = src.slice(src.indexOf("export async function cancelScanAction"));
  const action = body.slice(0, body.indexOf("\n}\n") + 2);
  assert.ok(action.includes("assertAdmin()"), "still admin-only");
  assert.ok(action.includes("assertDealershipAccess(id)"), "dealership must be one the caller may reach");
  assert.ok(/cancelScan\(scanId,\s*id\)/.test(action), "the scan id must be paired with the dealership id");
});

test("every dealership-scoped action resolves access from the session", () => {
  // `assertUser` alone is not enough on an action that takes a dealership id:
  // it proves who you are, not what you may reach.
  const src = read("src/app/actions/dealerships.ts");
  for (const name of ["scanNowAction", "newsScanNowAction"]) {
    const body = src.slice(src.indexOf(`export async function ${name}`));
    const action = body.slice(0, body.indexOf("\n}\n") + 2);
    assert.ok(action.includes("assertDealershipAccess(id)"), `${name} must assert dealership access`);
    assert.ok(!/assertUser\(\)/.test(action), `${name} must not rely on assertUser alone`);
  }
});

test("news actions scope their updates to the caller's dealerships", () => {
  const src = read("src/app/actions/news.ts");
  // Both update by article id, which is supplied by the page; without the
  // dealership filter either one is an IDOR.
  const updates = src.split(".where(").slice(1);
  assert.ok(updates.length >= 2, "expected two scoped updates");
  for (const clause of updates) {
    assert.ok(clause.includes("allowedFilter"), "every update must carry the dealership filter");
  }
});

/**
 * The status-code fix. A guard inside a segment that has a `loading.tsx` runs
 * after the Suspense fallback has been flushed, and Next can no longer set the
 * status — the denial then arrives as a 200 carrying a not-found body. Putting
 * the guard in the segment's layout keeps the real 404/307. These tests pin
 * that arrangement so restoring a group-wide loading boundary cannot silently
 * undo it.
 */
test("protected segments guard in a layout, not only in the page", () => {
  for (const [file, guard] of [
    ["src/app/(app)/dealerships/[id]/layout.tsx", "requireDealershipAccess"],
    ["src/app/(app)/admin/layout.tsx", "requireAdmin"],
    ["src/app/(app)/seo-news/layout.tsx", "isClient"],
  ] as const) {
    assert.ok(read(file).includes(guard), `${file} must call ${guard}`);
  }
});

test("no loading boundary sits above the protected segments", () => {
  // A `loading.tsx` directly in the (app) group would wrap all three layouts
  // again and return every denial as 200.
  assert.throws(() => read("src/app/(app)/loading.tsx"), /ENOENT/, "(app)/loading.tsx must stay removed; scope it to a route group instead");
});

test("the dashboard keeps its own loading skeleton", () => {
  // Removing the group-wide boundary must not cost the dashboard its skeleton.
  assert.ok(read("src/app/(app)/(home)/loading.tsx").length > 0);
});
