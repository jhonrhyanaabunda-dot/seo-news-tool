import "server-only";
import { errorMessage, logger } from "@/lib/logger";
import { upsertMonthlySnapshot } from "@/lib/history/snapshots";
import { reconcileIssueStatesAfterScan } from "@/lib/issues/states";

/**
 * Work that follows a successfully finalised scan and reads only what the scan
 * stored. Each step is independent and failure-isolated: a scan that completed
 * stays completed even if one of these cannot run, and maintenance backfills
 * the monthly snapshot later.
 *
 *  1. Monthly history: the month's snapshot (latest comparable scan wins).
 *  2. Issue workflow: verify fixes this scan confirms, reopen ones it contradicts.
 */
export async function afterScanCompleted(scanId: number, dealershipId: number): Promise<void> {
  try {
    await upsertMonthlySnapshot(scanId);
  } catch (err) {
    await logger.warn("history", "Monthly snapshot could not be recorded; maintenance will retry", { scanId, error: errorMessage(err) }, dealershipId);
  }
  try {
    const r = await reconcileIssueStatesAfterScan(scanId);
    if (r.verified || r.reopened) await logger.info("issues", "Issue workflow updated from scan", { scanId, ...r }, dealershipId);
  } catch (err) {
    await logger.warn("issues", "Issue workflow could not be reconciled with the scan", { scanId, error: errorMessage(err) }, dealershipId);
  }
}
