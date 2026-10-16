/**
 * Core Web Vitals: thresholds, PageSpeed Insights response parsing and the
 * snapshot schedule. Pure module (no database, network or environment), so it
 * is unit tested directly; pagespeed.ts and performance-job.ts do the I/O.
 *
 * None of this is part of the SEO score: lab results vary between runs and
 * field data changes daily, while the score must be reproducible.
 */
import type { FieldMetrics, WebVitalRating } from "@/lib/db/schema";

/** Google's published thresholds: good at or below the first value, poor above the second. */
export const VITAL_THRESHOLDS = {
  lcpMs: [2500, 4000],
  inpMs: [200, 500],
  cls: [0.1, 0.25],
  /** Lab-only companions, for colouring the Lighthouse values. */
  fcpMs: [1800, 3000],
  tbtMs: [200, 600],
} as const;
export type VitalMetric = keyof typeof VITAL_THRESHOLDS;

export const RATING_LABEL: Record<WebVitalRating, string> = { good: "Good", needs_improvement: "Needs improvement", poor: "Poor" };

export function rateVital(metric: VitalMetric, value: number | null | undefined): WebVitalRating | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const [good, poor] = VITAL_THRESHOLDS[metric];
  return value <= good ? "good" : value <= poor ? "needs_improvement" : "poor";
}

/** Lighthouse performance score bands (0–100). */
export function ratePerformanceScore(score: number | null | undefined): WebVitalRating | null {
  if (score === null || score === undefined) return null;
  return score >= 90 ? "good" : score >= 50 ? "needs_improvement" : "poor";
}

export interface PageSpeedResult {
  performance: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  strategy: string;
  /** CrUX field data, when Google has enough real-user traffic for the page or the site. */
  field?: FieldMetrics | null;
  error?: string;
}

const CRUX_CATEGORY: Record<string, WebVitalRating> = { FAST: "good", AVERAGE: "needs_improvement", SLOW: "poor" };

type CruxMetric = { percentile?: number; category?: string };
type Experience = { metrics?: Record<string, CruxMetric>; overall_category?: string; origin_fallback?: boolean };
export interface PageSpeedResponse {
  lighthouseResult?: { categories?: { performance?: { score?: number | null } }; audits?: Record<string, { numericValue?: number }> };
  loadingExperience?: Experience;
  originLoadingExperience?: Experience;
}

function parseField(exp: Experience | undefined, scope: FieldMetrics["scope"]): FieldMetrics | null {
  const m = exp?.metrics;
  if (!m) return null;
  const pct = (k: string) => (typeof m[k]?.percentile === "number" ? m[k].percentile! : null);
  const cat = (k: string) => CRUX_CATEGORY[m[k]?.category ?? ""] ?? null;
  // CrUX reports CLS ×100 (e.g. 5 = 0.05).
  const clsRaw = pct("CUMULATIVE_LAYOUT_SHIFT_SCORE");
  const field: FieldMetrics = {
    scope,
    lcpMs: pct("LARGEST_CONTENTFUL_PAINT_MS"),
    lcpCategory: cat("LARGEST_CONTENTFUL_PAINT_MS"),
    inpMs: pct("INTERACTION_TO_NEXT_PAINT"),
    inpCategory: cat("INTERACTION_TO_NEXT_PAINT"),
    cls: clsRaw === null ? null : Math.round(clsRaw) / 100,
    clsCategory: cat("CUMULATIVE_LAYOUT_SHIFT_SCORE"),
    overall: CRUX_CATEGORY[exp?.overall_category ?? ""] ?? null,
  };
  return field.lcpMs === null && field.inpMs === null && field.cls === null ? null : field;
}

/** Lab and field metrics from a PageSpeed Insights v5 response. */
export function parsePageSpeedResponse(data: PageSpeedResponse, strategy: string): PageSpeedResult {
  const audits = data.lighthouseResult?.audits ?? {};
  const num = (k: string) => (typeof audits[k]?.numericValue === "number" ? audits[k].numericValue! : null);
  const perf = data.lighthouseResult?.categories?.performance?.score;
  const lcp = num("largest-contentful-paint");
  const cls = num("cumulative-layout-shift");
  const tbt = num("total-blocking-time");
  const fcp = num("first-contentful-paint");
  // loadingExperience falls back to the whole origin when the page itself has too little traffic; say so.
  const exp = data.loadingExperience;
  const field = exp?.metrics ? parseField(exp, exp.origin_fallback ? "origin" : "url") : parseField(data.originLoadingExperience, "origin");
  return {
    performance: typeof perf === "number" ? Math.round(perf * 100) : null,
    lcpMs: lcp !== null ? Math.round(lcp) : null,
    cls: cls !== null ? Math.round(cls * 1000) / 1000 : null,
    tbtMs: tbt !== null ? Math.round(tbt) : null,
    fcpMs: fcp !== null ? Math.round(fcp) : null,
    strategy,
    field,
  };
}

/** Days between successful snapshots of a dealership. */
export const SNAPSHOT_INTERVAL_DAYS = 7;
/** After a failed attempt, wait this long before trying again (so a broken API key cannot cause a retry loop). */
export const SNAPSHOT_RETRY_HOURS = 24;

/**
 * Whether a dealership is due for a new snapshot, from stored timestamps only:
 * no successful snapshot within `intervalDays`, and no attempt at all within
 * the last SNAPSHOT_RETRY_HOURS. `intervalDays` 0 disables snapshots.
 */
export function performanceSnapshotDue(last: { successAt: Date | null; attemptAt: Date | null }, now: Date, intervalDays = SNAPSHOT_INTERVAL_DAYS): boolean {
  if (intervalDays <= 0) return false;
  if (last.successAt && now.getTime() - last.successAt.getTime() < intervalDays * 86_400_000) return false;
  if (last.attemptAt && now.getTime() - last.attemptAt.getTime() < SNAPSHOT_RETRY_HOURS * 3_600_000) return false;
  return true;
}

export interface PerformanceTarget {
  url: string;
  kind: "home" | "vdp";
}

/**
 * Pages to measure: the homepage and one vehicle detail page, chosen
 * deterministically (the first one crawled) from the scan's successful pages.
 */
export function pickPerformanceTargets(pages: Array<{ id: number; url: string; finalUrl: string | null; pageType: string | null; ok: boolean; confirmedVdp: boolean }>): PerformanceTarget[] {
  const sorted = [...pages].filter((p) => p.ok).sort((a, b) => a.id - b.id);
  const out: PerformanceTarget[] = [];
  const home = sorted.find((p) => p.pageType === "home");
  if (home) out.push({ url: home.finalUrl ?? home.url, kind: "home" });
  const vdp = sorted.find((p) => p.confirmedVdp);
  if (vdp) out.push({ url: vdp.finalUrl ?? vdp.url, kind: "vdp" });
  return out;
}
