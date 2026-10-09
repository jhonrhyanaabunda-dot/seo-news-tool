import "server-only";
import { inArray, sql, type Column, type SQL } from "drizzle-orm";

/**
 * A boolean SQL fragment restricting a query to the dealerships a user may see.
 *
 * `allowed === null` means A3 staff, who see everything, so the fragment is
 * `true` and the planner drops it. An empty allow-list yields `false`: a client
 * with no dealerships assigned sees nothing, which is the safe direction.
 *
 * `column` is always a literal written in this repository (e.g. `"d.id"`),
 * never anything that arrived from a request, so interpolating it is safe; the
 * ids themselves are bound as parameters.
 */
/**
 * The same restriction for Drizzle query builders. Returns `undefined` when the
 * user is unrestricted, so callers can pass it straight into `and(...)`.
 */
export function allowedFilter(allowed: number[] | null | undefined, column: Column): SQL | undefined {
  if (allowed === null || allowed === undefined) return undefined;
  // `inArray(col, [])` is invalid SQL, and an empty allow-list must match
  // nothing, so fall back to an id that cannot exist.
  return inArray(column, allowed.length ? allowed : [-1]);
}

export function dealershipSqlScope(allowed: number[] | null, column: string): SQL {
  if (allowed === null) return sql`true`;
  if (allowed.length === 0) return sql`false`;
  const ids = sql.join(
    allowed.map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`${sql.raw(column)} in (${ids})`;
}
