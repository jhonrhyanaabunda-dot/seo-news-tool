/**
 * The monthly SEO report: on the 1st of each month (local time), every active,
 * scanned dealership's report is generated and emailed to its recipients. It
 * covers the calendar month that just ended. Pure helpers, unit tested.
 */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** Reports go out on the first day of the month. */
export function isMonthlySendDay(localDate: string): boolean {
  return localDate.slice(8, 10) === "01";
}

/**
 * The month a report sent on `localDate` (YYYY-MM-DD, local) covers: the previous
 * calendar month. `start` is midnight UTC on its first day — close enough to
 * pick the scan the month is compared against (scans run once a day).
 */
export function reportedMonth(localDate: string): { key: string; label: string; start: Date } {
  const [y, m] = localDate.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month = m === 1 ? 12 : m - 1;
  return reportedMonthFromKey(`${year}-${String(month).padStart(2, "0")}`);
}

/** Label and start for a month key such as "2026-10". */
export function reportedMonthFromKey(key: string): { key: string; label: string; start: Date } {
  const [year, month] = key.split("-").map(Number);
  return { key, label: `${MONTHS[month - 1]} ${year}`, start: new Date(`${key}-01T00:00:00Z`) };
}

/** The one-line month summary at the top of the email. */
export function monthSummaryLine(label: string, scoreNow: number | null, scoreBefore: number | null): string {
  if (scoreNow === null) return `${label}: the website could not be scored in the latest check.`;
  if (scoreBefore === null) return `${label}: SEO score ${scoreNow}/100. This is the first month on record, so there is no earlier score to compare with.`;
  const d = scoreNow - scoreBefore;
  if (d === 0) return `${label}: SEO score ${scoreNow}/100, unchanged over the month.`;
  return `${label}: SEO score ${scoreNow}/100, ${d > 0 ? "up" : "down"} ${Math.abs(d)} point${Math.abs(d) === 1 ? "" : "s"} from ${scoreBefore} at the start of the month.`;
}
