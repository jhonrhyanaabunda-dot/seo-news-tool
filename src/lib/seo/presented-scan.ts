import { desc, sql } from "drizzle-orm";
import { seoScans } from "@/lib/db/schema";

/**
 * Which completed scan every surface presents: the newest scan that actually
 * read the site. A blocked scan evaluated nothing, so while a scan that did read
 * the site is at most this many days old it stays on screen (with a note that a
 * newer check was blocked) instead of "Not scored". Blocks on dealer sites have
 * been transient, and one that lasts longer than this still shows as Blocked,
 * because by then it needs the website provider to act.
 */
export const BLOCKED_FALLBACK_DAYS = 7;

/** Drizzle `orderBy` for completed scans of one dealership: the first row is the one to present. */
export const presentedScanOrder = [
  sql`case when ${seoScans.outcome} is distinct from 'blocked' and ${seoScans.completedAt} > now() - make_interval(days => ${BLOCKED_FALLBACK_DAYS}::int) then 0 else 1 end`,
  desc(seoScans.completedAt),
];

/** The same ordering for raw SQL over `seo_scans` under the alias `s`. */
export const presentedScanOrderSql = sql.raw(
  `case when s.outcome is distinct from 'blocked' and s.completed_at > now() - make_interval(days => ${BLOCKED_FALLBACK_DAYS}) then 0 else 1 end, s.completed_at desc`,
);
