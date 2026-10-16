/**
 * Bounded re-runs for once-per-period jobs (digests, monthly reports).
 *
 * The scheduler claims a period ("digest:daily" → "2026-10-16") *before* the
 * job runs, so overlapping ticks enqueue it once. The cost of claiming first is
 * that a job which exhausts its attempts would never run again that period
 * (Phase 1 J-04). The fix is to release the claim when the job finally fails,
 * so the next tick enqueues a fresh job — but only a bounded number of times
 * per period, so a mail server that stays down cannot turn into a retry loop.
 *
 * Re-running never duplicates mail: every recipient's send has its own
 * `email_reports.dedupe_key` (same period, same address → same key), so
 * recipients already served are skipped and only the failed ones are retried.
 *
 * Pure module: no database or environment, so the rule is unit-tested on its
 * own; `releaseFailedPeriod` in settings.ts applies it under a row lock.
 */

/** Fresh jobs per key and period after the first one has permanently failed. */
export const MAX_PERIOD_RELEASES = 2;

export interface PeriodRetryMarker {
  period: string;
  /** Releases already granted for `period`. */
  releases: number;
}

function asMarker(value: unknown): PeriodRetryMarker | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.period !== "string" || typeof v.releases !== "number" || !Number.isFinite(v.releases)) return null;
  return { period: v.period, releases: Math.max(0, Math.floor(v.releases)) };
}

/**
 * The period claim a job was enqueued under, or null for jobs that hold none.
 * Must produce exactly the keys the scheduler claims: `digest:daily` /
 * `digest:weekly` with the local date, and `monthly-report:<dealership>` with
 * the local month. A manually requested monthly report holds no claim, so its
 * failure must never hand back the scheduled month.
 */
export function periodClaimOf(type: string, payload: Record<string, unknown> | null | undefined): { key: string; period: string } | null {
  const p = payload ?? {};
  if (type === "digest" && typeof p.periodKey === "string" && p.periodKey) {
    return { key: `digest:${p.kind === "weekly" ? "weekly" : "daily"}`, period: p.periodKey };
  }
  if (type === "monthly_report" && !p.manual && typeof p.month === "string" && Number.isInteger(p.dealershipId)) {
    return { key: `monthly-report:${p.dealershipId}`, period: p.month };
  }
  return null;
}

/**
 * Decide whether a permanently failed job may release its period claim.
 *
 * A marker for an older period does not count against a new one: the budget
 * resets every period. An unreadable marker is treated as "no releases yet"
 * rather than "never again", because a corrupt row must not silence a digest.
 */
export function nextPeriodRelease(previous: unknown, period: string, max = MAX_PERIOD_RELEASES): { allowed: boolean; marker: PeriodRetryMarker } {
  const prev = asMarker(previous);
  const used = prev && prev.period === period ? prev.releases : 0;
  if (used >= max) return { allowed: false, marker: { period, releases: used } };
  return { allowed: true, marker: { period, releases: used + 1 } };
}
