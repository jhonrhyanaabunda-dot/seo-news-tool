import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships, jobs, scanEvents, seoScans } from "@/lib/db/schema";
import { createAlert } from "@/lib/changes/alerts";
import { enqueueJob } from "@/lib/jobs/queue";
import { env } from "@/lib/env";
import { allRegions, resolveRegion } from "@/lib/crawler/regions";

export const ACTIVE_SCAN_STATUSES = ["queued", "crawling", "finalizing"] as const;

/**
 * Create a scan record and its job. Returns null if the dealership already
 * has a scan in progress (enforced by a partial unique index, so concurrent
 * schedulers cannot create duplicates).
 */
export async function createScanAndJob(dealershipId: number, trigger: "scheduled" | "manual"): Promise<number | null> {
  const [dealer] = await db.select().from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!dealer) return null;
  const region = resolveRegion(dealer.preferredRegion, env().DEFAULT_CRAWLER_REGION, allRegions(env().CRAWLER_EXTRA_REGIONS));
  const [scan] = await db
    .insert(seoScans)
    .values({ dealershipId, trigger, status: "queued", websiteUrl: dealer.websiteUrl, region, maxPages: dealer.maxPages ?? env().CRAWLER_DEFAULT_MAX_PAGES })
    .onConflictDoNothing()
    .returning({ id: seoScans.id });
  if (!scan) return null;
  const jobId = await enqueueJob({
    type: "seo_scan",
    dealershipId,
    payload: { scanId: scan.id },
    dedupeKey: `seo:${dealershipId}`,
    priority: trigger === "manual" ? 20 : 50,
    maxAttempts: 3,
    region,
  });
  if (jobId === null) {
    // A job for this dealership is still queued or running (its dedupe key is taken), so nothing would ever
    // process this scan — and as an "active" scan it would block every new one until maintenance failed it
    // hours later. Remove it instead; the existing job carries on with its own scan.
    await db.delete(seoScans).where(eq(seoScans.id, scan.id));
    return null;
  }
  await db.update(dealerships).set({ lastSeoScanAt: new Date() }).where(eq(dealerships.id, dealershipId));
  await logScanEvent(scan.id, "info", trigger === "manual" ? "Scan requested manually" : "Scheduled scan queued");
  return scan.id;
}

export async function logScanEvent(scanId: number, level: "info" | "warn" | "error", message: string, details?: Record<string, unknown>) {
  await db.insert(scanEvents).values({ scanId, level, message, details });
}

export async function markScanFailed(scanId: number, message: string) {
  const [scan] = await db
    .update(seoScans)
    .set({ status: "failed", errorMessage: message.slice(0, 2000), completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(seoScans.id, scanId), inArray(seoScans.status, [...ACTIVE_SCAN_STATUSES])))
    .returning();
  if (!scan) return;
  await logScanEvent(scanId, "error", "Scan failed", { message });
  const [dealer] = await db.select().from(dealerships).where(eq(dealerships.id, scan.dealershipId)).limit(1);
  if (dealer) {
    await createAlert({
      dealershipId: dealer.id,
      scanId,
      type: "scan_failed",
      severity: "warning",
      title: `${dealer.name}: SEO scan could not be completed`,
      message,
      dedupeKey: `scan_failed:${dealer.id}:${scanId}`,
    });
  }
}

/**
 * Cancel a scan. A queued job is cancelled with it so no crawler picks it up; a
 * crawler already running it sees the status within one page and stops.
 */
export async function cancelScan(scanId: number) {
  await db
    .update(seoScans)
    .set({ status: "cancelled", completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(seoScans.id, scanId), inArray(seoScans.status, [...ACTIVE_SCAN_STATUSES])));
  await db
    .update(jobs)
    .set({ status: "cancelled", completedAt: new Date(), lockedAt: null, lockedBy: null })
    .where(and(eq(jobs.type, "seo_scan"), eq(jobs.status, "queued"), sql`(${jobs.payload}->>'scanId')::bigint = ${scanId}`));
}
