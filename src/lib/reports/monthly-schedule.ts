/**
 * When the monthly SEO report is due, and the job that sends it. Pure module
 * (no database, no environment) so the calendar rule can be unit-tested.
 */

export interface MonthlyReportSettings {
  monthlyReportEnabled: boolean;
  /** 1–28. */
  monthlyReportDay: number;
  /** 0–23, APP_TIMEZONE. */
  monthlyReportHour: number;
}

/**
 * The local month ("YYYY-MM") whose report is due at this moment, or null.
 *
 * Due from the configured hour on the configured day for the rest of the
 * month, so a missed tick (or a crawler-only outage of the web app) still sends
 * later the same month rather than skipping it. The per-dealership period claim
 * is what keeps it to once a month.
 */
export function monthlyReportMonthDue(local: { date: string; hour: number }, s: MonthlyReportSettings): string | null {
  if (!s.monthlyReportEnabled) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(local.date);
  if (!m) return null;
  const day = Number(m[3]);
  if (day < s.monthlyReportDay) return null;
  if (day === s.monthlyReportDay && local.hour < s.monthlyReportHour) return null;
  return `${m[1]}-${m[2]}`;
}

/** The job for a dealership's scheduled monthly report. Its dedupe key keeps one active job per dealership and month. */
export function monthlyReportJob(dealershipId: number, month: string) {
  return {
    type: "monthly_report" as const,
    dealershipId,
    payload: { dealershipId, month },
    dedupeKey: `monthly-report:${dealershipId}:${month}`,
    priority: 40,
    maxAttempts: 3,
  };
}

/**
 * A manual "send now" (admin testing). It holds no period claim, uses its own
 * email dedupe keys and never consumes the scheduled send for the month.
 */
export function manualMonthlyReportJob(dealershipId: number, month: string, requestedBy: number, onlyTo: string | null, nonce: string) {
  return {
    type: "monthly_report" as const,
    dealershipId,
    payload: { dealershipId, month, manual: true, requestedBy, onlyTo, nonce },
    dedupeKey: `monthly-report:manual:${dealershipId}:${nonce}`,
    priority: 20,
    maxAttempts: 2,
  };
}

/** "2026-10" → "October 2026". */
export function monthLabel(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${names[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

/** "2026-01" → "2025-12". */
export function previousMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return month;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return mo === 1 ? `${y - 1}-12` : `${m[1]}-${String(mo - 1).padStart(2, "0")}`;
}

/** The `n` months ending with `month`, oldest first. */
export function monthsEndingWith(month: string, n: number): string[] {
  const out = [month];
  while (out.length < n) out.unshift(previousMonth(out[0]));
  return out;
}

/** The email dedupe key for one recipient of one monthly report. */
export function monthlyEmailDedupeKey(payload: { dealershipId: number; month: string; manual?: boolean; nonce?: string }, to: string): string {
  return payload.manual ? `monthly:${payload.dealershipId}:${payload.month}:manual:${payload.nonce ?? "x"}:${to}` : `monthly:${payload.dealershipId}:${payload.month}:${to}`;
}
