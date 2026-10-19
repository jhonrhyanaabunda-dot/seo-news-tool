import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealershipIntegrations, gscDaily, gscTopItems, placeSnapshots, type Dealership, type DealershipIntegration, type GscTopItem } from "@/lib/db/schema";
import { comparePeriods, weeklySeries, type PeriodComparison } from "./gsc";

/**
 * Stored integration data without any session/auth dependency, so background
 * jobs (report findings) can use it. Page loaders in queries.ts add the
 * tenancy check on top.
 */

export async function integrationRows(dealershipId: number): Promise<Partial<Record<"gsc" | "places", DealershipIntegration>>> {
  const rows = await db.select().from(dealershipIntegrations).where(eq(dealershipIntegrations.dealershipId, dealershipId));
  return Object.fromEntries(rows.map((r) => [r.kind, r]));
}

export interface SearchPerformance {
  property: string;
  status: DealershipIntegration | null;
  comparison: PeriodComparison | null;
  weekly: Array<{ weekEnd: string; clicks: number; impressions: number }>;
  topQueries: GscTopItem[];
  topPages: GscTopItem[];
}

/** About 15 months of weekly points: the history Search Console keeps. */
const TREND_WEEKS = 66;

export async function loadSearchPerformance(dealer: Dealership, status: DealershipIntegration | null): Promise<SearchPerformance | null> {
  if (!dealer.gscProperty) return null;
  const property = dealer.gscProperty;
  const daily = await db
    .select({ date: gscDaily.date, clicks: gscDaily.clicks, impressions: gscDaily.impressions, position: gscDaily.position })
    .from(gscDaily)
    .where(and(eq(gscDaily.dealershipId, dealer.id), eq(gscDaily.property, property)))
    .orderBy(asc(gscDaily.date));
  const latest = daily[daily.length - 1]?.date ?? null;
  // Top lists belong to the property only once a sync of this property finished.
  const topCurrent = status?.configKey === property && status.status === "ok";
  const top =
    latest && topCurrent
      ? await db
          .select()
          .from(gscTopItems)
          .where(eq(gscTopItems.dealershipId, dealer.id))
          .orderBy(desc(gscTopItems.clicks), desc(gscTopItems.impressions), asc(gscTopItems.key))
      : [];
  return {
    property,
    status,
    comparison: latest ? comparePeriods(daily, latest, null) : null,
    weekly: latest ? weeklySeries(daily, latest, TREND_WEEKS, daily[0].date) : [],
    topQueries: top.filter((t) => t.kind === "query").slice(0, 10),
    topPages: top.filter((t) => t.kind === "page").slice(0, 10),
  };
}

export type IntegrationFindings = {
  searchConsole?: {
    periodStart: string;
    periodEnd: string;
    clicks: number;
    impressions: number;
    ctrPct: number;
    position: number | null;
    previous: { clicks: number; impressions: number; ctrPct: number; position: number | null } | null;
  };
  googleListing?: { rating: number | null; reviewCount: number | null; capturedOn: string };
};

/**
 * Latest Search Console 28-day totals and Google listing figures for report
 * findings. Rounded here so the numbers a narrative may quote are exactly the
 * ones the report shows. Built from stored data only (no clock).
 */
export async function integrationFindings(dealer: Dealership): Promise<IntegrationFindings> {
  const out: IntegrationFindings = {};
  if (dealer.gscProperty) {
    const status = await integrationRows(dealer.id);
    const c = (await loadSearchPerformance(dealer, status.gsc ?? null))?.comparison;
    if (c && (c.current.impressions > 0 || c.current.clicks > 0)) {
      const round = (t: typeof c.current) => ({ clicks: t.clicks, impressions: t.impressions, ctrPct: Math.round(t.ctr * 1000) / 10, position: t.position === null ? null : Math.round(t.position * 10) / 10 });
      out.searchConsole = { periodStart: c.periodStart, periodEnd: c.periodEnd, ...round(c.current), previous: c.previous ? round(c.previous) : null };
    }
  }
  if (dealer.googlePlaceId) {
    const [p] = await db.select().from(placeSnapshots).where(eq(placeSnapshots.dealershipId, dealer.id)).orderBy(desc(placeSnapshots.capturedAt)).limit(1);
    if (p && (p.rating !== null || p.reviewCount !== null)) out.googleListing = { rating: p.rating, reviewCount: p.reviewCount, capturedOn: p.capturedAt.toISOString().slice(0, 10) };
  }
  return out;
}
