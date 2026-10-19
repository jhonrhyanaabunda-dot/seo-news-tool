import "server-only";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { performanceSnapshots } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs/queue";
import { pageSpeedEnabled, runPageSpeed } from "./pagespeed";
import { performanceSnapshotDue, type PerformanceTarget } from "./web-vitals";

/**
 * Core Web Vitals snapshots: PageSpeed Insights for the homepage and one
 * vehicle detail page, run as a separate low-priority job after a completed
 * scan so the scan itself never waits ~1 minute per Google request.
 *
 * At most one snapshot per dealership per PERFORMANCE_SNAPSHOT_DAYS, decided
 * from the stored captured_at timestamps (checked when queuing and again when
 * the job runs, so overlapping scans cannot double up). Without an API key
 * nothing is queued. Results are shown, never scored.
 */

/** Below this much remaining time the job waits for the next tick: two Google requests take up to 2 minutes. */
const MIN_BUDGET_MS = 140_000;
const REQUEST_TIMEOUT_MS = 60_000;

async function lastSnapshotTimes(dealershipId: number): Promise<{ successAt: Date | null; attemptAt: Date | null }> {
  const [success] = await db
    .select({ at: performanceSnapshots.capturedAt })
    .from(performanceSnapshots)
    .where(and(eq(performanceSnapshots.dealershipId, dealershipId), isNull(performanceSnapshots.error)))
    .orderBy(desc(performanceSnapshots.capturedAt))
    .limit(1);
  const [attempt] = await db
    .select({ at: performanceSnapshots.capturedAt })
    .from(performanceSnapshots)
    .where(eq(performanceSnapshots.dealershipId, dealershipId))
    .orderBy(desc(performanceSnapshots.capturedAt))
    .limit(1);
  return { successAt: success?.at ?? null, attemptAt: attempt?.at ?? null };
}

/** Queue a snapshot after a completed scan, when one is due. Returns the job id, or null when nothing was queued. */
export async function queuePerformanceSnapshot(input: { dealershipId: number; scanId: number; targets: PerformanceTarget[] }, now = new Date()): Promise<number | null> {
  if (!pageSpeedEnabled() || !input.targets.length) return null;
  if (!performanceSnapshotDue(await lastSnapshotTimes(input.dealershipId), now, env().PERFORMANCE_SNAPSHOT_DAYS)) return null;
  return enqueueJob({
    type: "performance_snapshot",
    dealershipId: input.dealershipId,
    payload: { scanId: input.scanId, targets: input.targets },
    dedupeKey: `performance:${input.dealershipId}`,
    priority: 150,
    maxAttempts: 2,
  });
}

/** Run a queued snapshot. "deferred" = not enough time left in this tick; the job is retried on the next one. */
export async function runPerformanceSnapshotJob(job: { dealershipId: number | null; payload: Record<string, unknown> }, deadline: number): Promise<{ status: "deferred" } | { status: "done"; captured: number; skipped?: string }> {
  const dealershipId = Number(job.dealershipId);
  if (!pageSpeedEnabled()) return { status: "done", captured: 0, skipped: "PAGESPEED_API_KEY is not configured" };
  if (!performanceSnapshotDue(await lastSnapshotTimes(dealershipId), new Date(), env().PERFORMANCE_SNAPSHOT_DAYS)) return { status: "done", captured: 0, skipped: "a recent snapshot exists" };
  if (deadline - Date.now() < MIN_BUDGET_MS) return { status: "deferred" };
  const targets = (Array.isArray(job.payload.targets) ? job.payload.targets : []) as PerformanceTarget[];
  const scanId = typeof job.payload.scanId === "number" ? job.payload.scanId : null;
  let captured = 0;
  for (const t of targets.slice(0, 2)) {
    if (typeof t?.url !== "string" || (t.kind !== "home" && t.kind !== "vdp")) continue;
    const r = await runPageSpeed(t.url, "mobile", REQUEST_TIMEOUT_MS);
    // The scan may have been deleted meanwhile; keep the measurement without the link.
    const scanExists = scanId !== null && (await db.execute(sql`select 1 from seo_scans where id = ${scanId}`)).length > 0;
    await db.insert(performanceSnapshots).values({
      dealershipId,
      scanId: scanExists ? scanId : null,
      url: t.url.slice(0, 2000),
      pageKind: t.kind,
      strategy: "mobile",
      performance: r.performance,
      lcpMs: r.lcpMs,
      cls: r.cls,
      tbtMs: r.tbtMs,
      fcpMs: r.fcpMs,
      field: r.field ?? null,
      error: r.error?.slice(0, 500) ?? null,
    });
    if (!r.error) captured++;
  }
  return { status: "done", captured };
}
