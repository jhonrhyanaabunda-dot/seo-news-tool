/**
 * Google Search Console — pure helpers (no network, database or clock reads
 * except where a date is passed in), so they are unit tested directly.
 *
 * Search Analytics reports days in Pacific Time, keeps 16 months of history,
 * and its "final" data lags two to three days. A first sync reads the whole
 * history; later syncs re-read the last REFRESH_DAYS so late-arriving days are
 * filled in and revised days overwritten.
 */
import { GoogleApiError } from "./google-auth";

export const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";
export const GSC_API_BASE = "https://searchconsole.googleapis.com/webmasters/v3/sites";
/** Search Console keeps 16 months; ask for a little less so the start is always accepted. */
export const GSC_HISTORY_DAYS = 480;
export const GSC_REFRESH_DAYS = 10;
export const GSC_PERIOD_DAYS = 28;
/** Top queries / pages kept per sync. Modest on purpose: the UI shows the top few and quotas are per request rows. */
export const GSC_TOP_ROWS = 25;

export type GscPropertyCheck = { ok: true; value: string } | { ok: false; error: string };

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

/**
 * Accepts the two Search Console property kinds:
 *  - Domain property  "sc-domain:example.com"
 *  - URL-prefix       "https://www.example.com/" (a trailing slash is added)
 */
export function validateGscProperty(input: string): GscPropertyCheck {
  const v = input.trim();
  if (/^sc-domain:/i.test(v)) {
    const domain = v.slice("sc-domain:".length).trim().toLowerCase().replace(/\.$/, "");
    if (!DOMAIN_RE.test(domain)) return { ok: false, error: "Enter a domain property as sc-domain:example.com (no https:// or path)." };
    return { ok: true, value: `sc-domain:${domain}` };
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return { ok: false, error: "Enter the property exactly as Search Console shows it: sc-domain:example.com or https://www.example.com/" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false, error: "A URL-prefix property starts with https:// or http://." };
  if (url.search || url.hash || url.username || url.password) return { ok: false, error: "A URL-prefix property has no query string, fragment or credentials." };
  if (!DOMAIN_RE.test(url.hostname)) return { ok: false, error: "The property's host is not a public domain." };
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  return { ok: true, value: `${url.protocol}//${url.host.toLowerCase()}${path}` };
}

/** The host a property covers ("example.com" for both kinds; www kept for URL-prefix). */
export function gscPropertyHost(property: string): string {
  if (property.startsWith("sc-domain:")) return property.slice("sc-domain:".length);
  try {
    return new URL(property).hostname;
  } catch {
    return property;
  }
}

/** Today's date in Pacific Time (Search Console's reporting day), YYYY-MM-DD. */
export function pacificDate(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Calendar arithmetic on YYYY-MM-DD strings (UTC-based, so no DST surprises). */
export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** Date range to request. `latestStored` is the newest stored day for the current property, or null on a first sync. */
export function syncWindow(today: string, latestStored: string | null): { startDate: string; endDate: string; initial: boolean } {
  const endDate = addDays(today, -1);
  const earliest = addDays(endDate, -GSC_HISTORY_DAYS);
  if (!latestStored) return { startDate: earliest, endDate, initial: true };
  let startDate = addDays(latestStored, -GSC_REFRESH_DAYS);
  if (startDate < earliest) startDate = earliest;
  if (startDate > endDate) startDate = addDays(endDate, -GSC_REFRESH_DAYS);
  return { startDate, endDate, initial: false };
}

export interface SearchAnalyticsRequest {
  startDate: string;
  endDate: string;
  dimensions: Array<"date" | "query" | "page">;
  type: "web";
  rowLimit: number;
  startRow?: number;
}

export function searchAnalyticsRequest(startDate: string, endDate: string, dimension: "date" | "query" | "page", rowLimit: number): SearchAnalyticsRequest {
  return { startDate, endDate, dimensions: [dimension], type: "web", rowLimit };
}

export function searchAnalyticsUrl(property: string): string {
  return `${GSC_API_BASE}/${encodeURIComponent(property)}/searchAnalytics/query`;
}

export interface GscRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
}

/** Validate and normalise a Search Analytics response; malformed rows are dropped, not trusted. */
export function parseSearchAnalytics(json: unknown): GscRow[] {
  const rows = (json as { rows?: unknown })?.rows;
  if (!Array.isArray(rows)) return [];
  const out: GscRow[] = [];
  for (const r of rows) {
    const row = r as { keys?: unknown; clicks?: unknown; impressions?: unknown; ctr?: unknown; position?: unknown };
    if (!Array.isArray(row.keys) || typeof row.keys[0] !== "string") continue;
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    if (!Number.isFinite(clicks) || !Number.isFinite(impressions) || clicks < 0 || impressions < 0) continue;
    const ctr = Number(row.ctr);
    const position = Number(row.position);
    out.push({
      key: row.keys[0].slice(0, 2000),
      clicks: Math.round(clicks),
      impressions: Math.round(impressions),
      ctr: Number.isFinite(ctr) ? ctr : impressions > 0 ? clicks / impressions : 0,
      position: Number.isFinite(position) && position > 0 ? position : null,
    });
  }
  return out;
}

/** Readable, actionable error for a Search Console API failure. Permanent errors are not retried. */
export function gscApiError(status: number, body: string, serviceAccountEmail: string): GoogleApiError {
  let message = "";
  try {
    message = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? "";
  } catch {
    /* not JSON */
  }
  const detail = message ? ` Google said: "${message.slice(0, 200)}"` : "";
  if (status === 403) {
    return new GoogleApiError(
      `The service account has no access to this Search Console property. In Search Console → Settings → Users and permissions, add ${serviceAccountEmail} as a user (Restricted is enough), and make sure the Search Console API is enabled in the Google Cloud project.${detail}`,
      true,
      status,
    );
  }
  if (status === 404) return new GoogleApiError(`Search Console has no property with this exact name. Copy it from the Search Console property picker (sc-domain:… or the full https://…/ prefix).${detail}`, true, status);
  if (status === 400) return new GoogleApiError(`Search Console rejected the request.${detail}`, true, status);
  if (status === 401) return new GoogleApiError(`Search Console did not accept the access token.${detail}`, false, status);
  if (status === 429) return new GoogleApiError(`Search Console quota exceeded; the sync will be retried later.${detail}`, false, status);
  return new GoogleApiError(`Search Console API returned HTTP ${status}.${detail}`, status < 500, status);
}

/* ─────────────────────── Aggregation for the UI and reports ─────────────────────── */

export interface DailyPoint {
  date: string;
  clicks: number;
  impressions: number;
  position: number | null;
}

export interface GscTotals {
  clicks: number;
  impressions: number;
  /** clicks / impressions, 0–1. */
  ctr: number;
  /** Impression-weighted average position, or null without impressions. */
  position: number | null;
}

export function totals(points: DailyPoint[]): GscTotals {
  let clicks = 0;
  let impressions = 0;
  let weighted = 0;
  let weight = 0;
  for (const p of points) {
    clicks += p.clicks;
    impressions += p.impressions;
    if (p.position !== null && p.impressions > 0) {
      weighted += p.position * p.impressions;
      weight += p.impressions;
    }
  }
  return { clicks, impressions, ctr: impressions > 0 ? clicks / impressions : 0, position: weight > 0 ? weighted / weight : null };
}

export interface PeriodComparison {
  periodStart: string;
  periodEnd: string;
  current: GscTotals;
  /** The 28 days before; null when the stored history does not cover them. */
  previous: GscTotals | null;
  previousStart: string;
  previousEnd: string;
}

/**
 * The last 28 days with data versus the 28 days before. Days missing from the
 * data had no impressions and count as zero, but only inside the range the
 * history covers (`historyStart`, the first day ever requested).
 */
export function comparePeriods(points: DailyPoint[], periodEnd: string, historyStart: string | null): PeriodComparison {
  const periodStart = addDays(periodEnd, -(GSC_PERIOD_DAYS - 1));
  const previousEnd = addDays(periodStart, -1);
  const previousStart = addDays(previousEnd, -(GSC_PERIOD_DAYS - 1));
  const inRange = (a: string, b: string) => points.filter((p) => p.date >= a && p.date <= b);
  const earliest = historyStart ?? points.reduce<string | null>((m, p) => (m === null || p.date < m ? p.date : m), null);
  const covered = earliest !== null && earliest <= previousStart;
  return {
    periodStart,
    periodEnd,
    current: totals(inRange(periodStart, periodEnd)),
    previous: covered ? totals(inRange(previousStart, previousEnd)) : null,
    previousStart,
    previousEnd,
  };
}

/** Percentage change, or null when there is no baseline. */
export function pctChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

/** Weekly sums ending at `end`, oldest first (for the trend chart). Weeks before the history are omitted. */
export function weeklySeries(points: DailyPoint[], end: string, weeks: number, historyStart: string | null): Array<{ weekEnd: string; clicks: number; impressions: number }> {
  const out: Array<{ weekEnd: string; clicks: number; impressions: number }> = [];
  for (let w = weeks - 1; w >= 0; w--) {
    const weekEnd = addDays(end, -7 * w);
    const weekStart = addDays(weekEnd, -6);
    if (historyStart && weekStart < historyStart) continue;
    const t = totals(points.filter((p) => p.date >= weekStart && p.date <= weekEnd));
    out.push({ weekEnd, clicks: t.clicks, impressions: t.impressions });
  }
  return out;
}
