/**
 * Long-term monthly history: which scan represents a month, what a snapshot
 * keeps, and how two months compare. Pure module (no database or environment);
 * `snapshots.ts` stores and reads the rows.
 *
 * A snapshot never recomputes anything. Score, category scores and counts are
 * copied from the scan row; the per-check summary is a grouping of that scan's
 * own issue rows, ordered by the same priority table every other surface uses.
 */
import type { CategoryScores, MonthlyCheckSummary } from "@/lib/db/schema";
import { localParts } from "@/lib/local-time";
import { CHECKS_BY_KEY } from "@/lib/seo/checks/config";
import { PRIORITY_ORDER, priorityFor } from "@/lib/seo/priority";

export const MAX_SAMPLE_URLS = 5;
/** Months shown on the History tab. */
export const HISTORY_MONTHS = 12;

/** "YYYY-MM" of an instant in the app's timezone (a scan at 00:30 on the 1st Central belongs to that month). */
export function monthOf(date: Date, timeZone: string): string {
  return localParts(date, timeZone).date.slice(0, 7);
}

export interface SnapshotCandidate {
  status: string;
  outcome: string | null;
  score: number | null;
  siteAvailable: boolean | null;
  completedAt: Date | null;
  auditMode?: string | null;
}

/**
 * Only a scan that could read the whole site stands for a month, the same rule
 * change detection uses for its baseline: completed, scored, site up, a full
 * crawl, and neither blocked nor partially blocked. A month whose only scans
 * were refused by the website has no snapshot rather than a misleading one.
 */
export function isSnapshotEligible(s: SnapshotCandidate): boolean {
  return (
    s.status === "completed" &&
    s.completedAt !== null &&
    s.score !== null &&
    s.siteAvailable === true &&
    (s.auditMode ?? "full") === "full" &&
    s.outcome !== "blocked" &&
    s.outcome !== "partially_blocked"
  );
}

/** Latest comparable scan of the month wins; an equal timestamp re-applies (idempotent backfill). */
export function replacesSnapshot(existingCompletedAt: Date | null, candidateCompletedAt: Date): boolean {
  return existingCompletedAt === null || candidateCompletedAt.getTime() >= existingCompletedAt.getTime();
}

/**
 * Group one scan's issue rows by check. Affected = distinct URLs, matching the
 * report findings (for link checks those URLs are the broken links). Ordered
 * by priority, then reach, then key — the shared opportunity order.
 */
export function summarizeChecks(rows: Array<{ checkKey: string; severity: "critical" | "warning" | "info"; url: string }>): MonthlyCheckSummary[] {
  const groups = new Map<string, { checkKey: string; severity: "critical" | "warning" | "info"; urls: Set<string> }>();
  for (const r of rows) {
    const key = `${r.checkKey}|${r.severity}`;
    const g = groups.get(key) ?? { checkKey: r.checkKey, severity: r.severity, urls: new Set<string>() };
    g.urls.add(r.url);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({
      checkKey: g.checkKey,
      severity: g.severity,
      priority: priorityFor(g.checkKey, g.severity),
      affectedPages: g.urls.size,
      sampleUrls: [...g.urls].sort().slice(0, MAX_SAMPLE_URLS),
    }))
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.affectedPages - a.affectedPages || a.checkKey.localeCompare(b.checkKey) || a.severity.localeCompare(b.severity));
}

export interface MonthSnapshotLike {
  month: string;
  score: number | null;
  categoryScores?: CategoryScores | null;
  /** Stored snapshot checks, or the report findings' issues for the month being reported. */
  checks: Array<Pick<MonthlyCheckSummary, "checkKey" | "priority" | "affectedPages">>;
}

export interface CheckChange {
  checkKey: string;
  title: string;
  priority: MonthlyCheckSummary["priority"];
  before: number;
  after: number;
}

export interface MonthComparison {
  month: string;
  previousMonth: string | null;
  score: number | null;
  scoreDelta: number | null;
  /** Checks failing this month that were not failing the month before. */
  newChecks: CheckChange[];
  /** Checks failing the month before that pass this month. */
  resolvedChecks: CheckChange[];
  /** Still failing, on fewer pages. */
  improved: CheckChange[];
  /** Still failing, on more pages. */
  worsened: CheckChange[];
  unchanged: number;
}

function byCheck(checks: MonthSnapshotLike["checks"]): Map<string, { affected: number; priority: MonthlyCheckSummary["priority"] }> {
  const out = new Map<string, { affected: number; priority: MonthlyCheckSummary["priority"] }>();
  for (const c of checks) {
    const prev = out.get(c.checkKey);
    // One check can appear under two severities (e.g. a noindex on a key page vs. others).
    const priority = prev && PRIORITY_ORDER[prev.priority] <= PRIORITY_ORDER[c.priority] ? prev.priority : c.priority;
    out.set(c.checkKey, { affected: (prev?.affected ?? 0) + c.affectedPages, priority });
  }
  return out;
}

const order = (a: CheckChange, b: CheckChange) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || Math.abs(b.after - b.before) - Math.abs(a.after - a.before) || a.checkKey.localeCompare(b.checkKey);

/**
 * Month-over-month change between two stored snapshots. With no previous
 * snapshot there is no comparison: every list is empty and the delta null, so
 * a first month is never presented as "everything is new".
 */
export function compareMonths(current: MonthSnapshotLike, previous: MonthSnapshotLike | null): MonthComparison {
  const base: MonthComparison = { month: current.month, previousMonth: previous?.month ?? null, score: current.score, scoreDelta: null, newChecks: [], resolvedChecks: [], improved: [], worsened: [], unchanged: 0 };
  if (!previous) return base;
  base.scoreDelta = current.score !== null && previous.score !== null ? current.score - previous.score : null;
  const now = byCheck(current.checks);
  const before = byCheck(previous.checks);
  const title = (k: string) => CHECKS_BY_KEY[k]?.problem ?? k;
  for (const [k, v] of now) {
    const b = before.get(k);
    const change = { checkKey: k, title: title(k), priority: v.priority, before: b?.affected ?? 0, after: v.affected };
    if (!b) base.newChecks.push(change);
    else if (v.affected < b.affected) base.improved.push(change);
    else if (v.affected > b.affected) base.worsened.push(change);
    else base.unchanged++;
  }
  for (const [k, b] of before) {
    if (!now.has(k)) base.resolvedChecks.push({ checkKey: k, title: title(k), priority: b.priority, before: b.affected, after: 0 });
  }
  base.newChecks.sort(order);
  base.resolvedChecks.sort(order);
  base.improved.sort(order);
  base.worsened.sort(order);
  return base;
}

/** The snapshot for each of `months`, or null where the month has none. */
export function alignToMonths<T extends { month: string }>(snapshots: T[], months: string[]): Array<T | null> {
  const by = new Map(snapshots.map((s) => [s.month, s]));
  return months.map((m) => by.get(m) ?? null);
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
