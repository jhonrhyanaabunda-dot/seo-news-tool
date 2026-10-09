/**
 * Calendar arithmetic in the configured timezone. Deliberately free of any
 * database or environment import so scheduling rules can be unit-tested on
 * their own.
 */

/** Local calendar parts in the configured timezone. */
export function localParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: weekdays.indexOf(parts.weekday),
  };
}

export interface QuietHours {
  crawlerQuietHoursEnabled: boolean;
  crawlerQuietStartHour: number;
  crawlerQuietEndHour: number;
}

/**
 * True when `date` falls inside the overnight quiet window. The start hour is
 * inclusive and the end hour exclusive; the window wraps midnight whenever the
 * start is later than the end (21:00 → 07:00 is the default). An equal start
 * and end means no quiet window, never a 24-hour one — silencing every alert by
 * accident is the failure worth designing against.
 */
export function inQuietHours(date: Date, s: QuietHours, timeZone: string): boolean {
  if (!s.crawlerQuietHoursEnabled) return false;
  const { crawlerQuietStartHour: start, crawlerQuietEndHour: end } = s;
  if (start === end) return false;
  const { hour } = localParts(date, timeZone);
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
