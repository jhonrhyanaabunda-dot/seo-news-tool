import "server-only";
import { and, asc, desc, eq, gte, lte, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { seoIssues, seoMonthlySnapshots, seoScans, type SeoMonthlySnapshot } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { isSnapshotEligible, monthOf, summarizeChecks } from "./monthly";

/** Snapshots older than this are removed by maintenance; well beyond the 12 months shown. */
export const SNAPSHOT_RETENTION_MONTHS = 36;

/**
 * Record (or refresh) the month's snapshot from one completed scan.
 *
 * Called when a scan completes and from maintenance before detail rows are
 * pruned. The upsert only replaces a row whose scan completed earlier, so a
 * backfill of an older scan can never overwrite a later one, and a re-run is
 * harmless. Returns false when the scan does not stand for a month (blocked,
 * not scored, …) or its detail rows are already gone.
 */
export async function upsertMonthlySnapshot(scanId: number): Promise<boolean> {
  const [scan] = await db.select().from(seoScans).where(eq(seoScans.id, scanId)).limit(1);
  if (!scan || !scan.completedAt || !scan.detailsRetained) return false;
  if (!isSnapshotEligible({ ...scan, auditMode: scan.siteChecks?.auditMode ?? null })) return false;
  const rows = await db.select({ checkKey: seoIssues.checkKey, severity: seoIssues.severity, url: seoIssues.url }).from(seoIssues).where(eq(seoIssues.scanId, scan.id));
  const values = {
    dealershipId: scan.dealershipId,
    month: monthOf(scan.completedAt, env().APP_TIMEZONE),
    scanId: scan.id,
    scanCompletedAt: scan.completedAt,
    score: scan.score,
    categoryScores: scan.categoryScores,
    criticalCount: scan.criticalCount,
    warningCount: scan.warningCount,
    infoCount: scan.infoCount,
    pagesScanned: scan.pagesScanned,
    checks: summarizeChecks(rows),
  };
  const out = await db
    .insert(seoMonthlySnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: [seoMonthlySnapshots.dealershipId, seoMonthlySnapshots.month],
      set: { ...values, updatedAt: new Date() },
      // Latest comparable scan of the month wins (see replacesSnapshot).
      setWhere: sql`${seoMonthlySnapshots.scanCompletedAt} <= ${scan.completedAt.toISOString()}::timestamptz`,
    })
    .returning({ id: seoMonthlySnapshots.id });
  return out.length > 0;
}

/**
 * Maintenance: snapshot every retained scan that is newer than its month's
 * stored snapshot. Covers the scans about to lose their detail rows, and fills
 * the history for data that existed before this table did. Bounded per run.
 */
export async function backfillMonthlySnapshots(limit = 300): Promise<number> {
  const tz = env().APP_TIMEZONE;
  const rows = await db.execute<{ id: number }>(sql`
    select s.id from seo_scans s
    where s.status = 'completed' and s.details_retained and s.score is not null and s.site_available
      and s.completed_at is not null and coalesce(s.site_checks->>'auditMode', 'full') = 'full' and s.outcome is distinct from 'blocked' and s.outcome is distinct from 'partially_blocked'
      and not exists (
        select 1 from seo_monthly_snapshots m
        where m.dealership_id = s.dealership_id
          and m.month = to_char(s.completed_at at time zone ${tz}, 'YYYY-MM')
          and m.scan_completed_at >= s.completed_at
      )
    order by s.completed_at asc
    limit ${limit}
  `);
  let n = 0;
  for (const r of rows as unknown as Array<{ id: number }>) if (await upsertMonthlySnapshot(Number(r.id))) n++;
  return n;
}

export async function pruneMonthlySnapshots(): Promise<number> {
  const r = await db.execute(sql`delete from seo_monthly_snapshots where scan_completed_at < now() - make_interval(months => ${SNAPSHOT_RETENTION_MONTHS}::int)`);
  return (r as unknown as { count?: number }).count ?? 0;
}

/** Snapshots for a dealership between two months inclusive, oldest first. */
export async function getMonthlySnapshots(dealershipId: number, fromMonth: string, toMonth: string): Promise<SeoMonthlySnapshot[]> {
  return db
    .select()
    .from(seoMonthlySnapshots)
    .where(and(eq(seoMonthlySnapshots.dealershipId, dealershipId), gte(seoMonthlySnapshots.month, fromMonth), lte(seoMonthlySnapshots.month, toMonth)))
    .orderBy(asc(seoMonthlySnapshots.month));
}

/** The latest snapshot strictly before `month`, if any. */
export async function getSnapshotBefore(dealershipId: number, month: string): Promise<SeoMonthlySnapshot | null> {
  const [row] = await db
    .select()
    .from(seoMonthlySnapshots)
    .where(and(eq(seoMonthlySnapshots.dealershipId, dealershipId), sql`${seoMonthlySnapshots.month} < ${month}`))
    .orderBy(desc(seoMonthlySnapshots.month))
    .limit(1);
  return row ?? null;
}

export async function getSnapshot(dealershipId: number, month: string): Promise<SeoMonthlySnapshot | null> {
  const [row] = await db.select().from(seoMonthlySnapshots).where(and(eq(seoMonthlySnapshots.dealershipId, dealershipId), eq(seoMonthlySnapshots.month, month))).limit(1);
  return row ?? null;
}
