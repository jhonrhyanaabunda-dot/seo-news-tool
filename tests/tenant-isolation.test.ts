import { test } from "node:test";
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { allowedFilter, dealershipSqlScope } from "@/lib/queries/scope";
import { dealerships } from "@/lib/db/schema";

/**
 * These cover the decision itself — "which dealerships may this user see, and
 * what does that become in SQL" — without needing a database. The rule that
 * matters is that the restriction can only ever narrow a query: staff get a
 * fragment the planner ignores, a client gets an explicit list, and a client
 * with nothing assigned gets a fragment matching no row. The live cross-tenant
 * checks run against the deployment separately.
 */

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);

const DEALER_A = 1;
const DEALER_B = 2;

test("A3 staff are unrestricted", () => {
  assert.equal(render(dealershipSqlScope(null, "d.id")).sql, "true");
  assert.equal(allowedFilter(null, dealerships.id), undefined);
});

test("a client's scope names only their own dealership", () => {
  const q = render(dealershipSqlScope([DEALER_A], "d.id"));
  assert.equal(q.sql, "d.id in ($1)");
  assert.deepEqual(q.params, [DEALER_A]);
  assert.ok(!q.params.includes(DEALER_B), "the other dealership must not appear");
});

test("an empty assignment matches nothing rather than everything", () => {
  // The dangerous failure is a half-provisioned client account widening to the
  // whole portfolio, so this asserts the opposite direction explicitly.
  assert.equal(render(dealershipSqlScope([], "d.id")).sql, "false");

  const filter = allowedFilter([], dealerships.id);
  assert.ok(filter, "an empty allow-list must still produce a filter");
  assert.deepEqual(render(filter).params, [-1], "falls back to an id that cannot exist");
});

test("undefined is treated as unrestricted, not as empty", () => {
  // `allowed` is optional on the news filters; a caller that omits it must
  // behave like staff rather than silently returning nothing.
  assert.equal(allowedFilter(undefined, dealerships.id), undefined);
});

test("every assigned dealership is preserved", () => {
  const q = render(dealershipSqlScope([DEALER_A, DEALER_B], "d.id"));
  assert.equal(q.sql, "d.id in ($1, $2)");
  assert.deepEqual(q.params, [DEALER_A, DEALER_B]);
});

test("ids are bound as parameters, never interpolated", () => {
  // The column name is a literal from this repo; the ids must stay parameters
  // so nothing a request influences can reach the statement text. The ids here
  // are deliberately unlike the `$1`/`$2` placeholders.
  const q = render(dealershipSqlScope([4071, 9182], "d.id"));
  assert.equal(q.sql, "d.id in ($1, $2)");
  assert.ok(!q.sql.includes("4071") && !q.sql.includes("9182"));
  assert.deepEqual(q.params, [4071, 9182]);
});
