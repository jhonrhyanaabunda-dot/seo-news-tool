import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alerts, dealerships, seoScans, type Dealership } from "@/lib/db/schema";
import { getOpportunities } from "./client-opportunities";
import type { Opportunity } from "@/lib/seo/opportunity";

/**
 * Everything the dealership-facing dashboard shows, in one place.
 *
 * This is a *view*, not a second source of truth. Every number here is either
 * read straight off the authoritative row (`seo_scans.score`,
 * `critical_count`, `warning_count`, `change_summary`) or derived from
 * `seo_issues` with the same `priorityFor` / `CHECKS_BY_KEY` mapping the report
 * uses. Nothing is recomputed, so the dashboard, the report and any future PDF
 * built from the same scan cannot disagree.
 *
 * What is deliberately absent: any fallback or placeholder. When a fact is not
 * in the database the field is null and the UI says so, because a dealership
 * reading an invented number is worse than one reading "not available yet".
 */

/** How many issues the dashboard puts in front of the reader before linking out. */
const TOP_ISSUES = 5;
/** Alerts worth a GM's attention, newest first. */
const RECENT_ACTIVITY = 6;
/** Points of score history on the trend line. */
const TREND_POINTS = 30;

export interface ClientDashboard {
  dealership: Pick<Dealership, "id" | "name" | "websiteUrl" | "brand" | "city" | "state" | "isActive" | "seoEnabled">;
  scan: {
    id: number;
    completedAt: Date | null;
    score: number | null;
    /** Points gained or lost against the previous comparable scan; null when there is none. */
    scoreDelta: number | null;
    previousScore: number | null;
    outcome: string | null;
    siteAvailable: boolean | null;
    pagesScanned: number;
    /** True once housekeeping has removed this scan's individual issue rows. */
    detailsRetained: boolean;
  } | null;
  /** A scan currently running, so the page can say so rather than look stale. */
  activeScan: { id: number; status: string } | null;
  counts: { critical: number; warning: number; info: number };
  pages: { total: number; healthy: number; warning: number; critical: number; notEvaluated: number };
  /** The first few of the same ordered list the opportunities page shows. */
  topIssues: Opportunity[];
  /** Total open opportunities, so the dashboard can link to "all N". */
  opportunityCount: number;
  trend: Array<{ at: Date; score: number }>;
  activity: Array<{ id: number; type: string; title: string; message: string; severity: string; createdAt: Date }>;
  /** Latest completed report, if one exists — the dashboard links to it rather than inventing one. */
  latestReportId: number | null;
}

export async function getClientDashboard(dealershipId: number): Promise<ClientDashboard | null> {
  const [dealership] = await db
    .select({
      id: dealerships.id,
      name: dealerships.name,
      websiteUrl: dealerships.websiteUrl,
      brand: dealerships.brand,
      city: dealerships.city,
      state: dealerships.state,
      isActive: dealerships.isActive,
      seoEnabled: dealerships.seoEnabled,
    })
    .from(dealerships)
    .where(eq(dealerships.id, dealershipId))
    .limit(1);
  if (!dealership) return null;

  const [latest] = await db
    .select()
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealershipId), eq(seoScans.status, "completed")))
    .orderBy(desc(seoScans.completedAt))
    .limit(1);

  const [active] = await db
    .select({ id: seoScans.id, status: seoScans.status })
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealershipId), inArray(seoScans.status, ["queued", "crawling", "finalizing"])))
    .limit(1);

  const [trendRows, activityRows, latestReport] = await Promise.all([
    db
      .select({ at: seoScans.completedAt, score: seoScans.score })
      .from(seoScans)
      .where(and(eq(seoScans.dealershipId, dealershipId), eq(seoScans.status, "completed"), sql`${seoScans.score} is not null`))
      .orderBy(desc(seoScans.completedAt))
      .limit(TREND_POINTS),
    db
      .select({ id: alerts.id, type: alerts.type, title: alerts.title, message: alerts.message, severity: alerts.severity, createdAt: alerts.createdAt })
      .from(alerts)
      .where(eq(alerts.dealershipId, dealershipId))
      .orderBy(desc(alerts.createdAt))
      .limit(RECENT_ACTIVITY),
    db.execute<{ id: number }>(sql`select id from reports where dealership_id = ${dealershipId} and status = 'completed' order by created_at desc limit 1`),
  ]);

  const empty: ClientDashboard = {
    dealership,
    scan: null,
    activeScan: active ? { id: active.id, status: active.status } : null,
    counts: { critical: 0, warning: 0, info: 0 },
    pages: { total: 0, healthy: 0, warning: 0, critical: 0, notEvaluated: 0 },
    topIssues: [],
    opportunityCount: 0,
    // Oldest first, so the chart reads left to right.
    trend: trendRows.reverse().flatMap((r) => (r.at && r.score !== null ? [{ at: r.at, score: r.score }] : [])),
    activity: activityRows,
    latestReportId: (latestReport as unknown as Array<{ id: number }>)[0]?.id ?? null,
  };
  if (!latest) return empty;

  const change = latest.changeSummary;
  const opportunities = await getOpportunities(latest.id);
  return {
    ...empty,
    scan: {
      id: latest.id,
      completedAt: latest.completedAt,
      score: latest.score,
      scoreDelta: change?.scoreDelta ?? null,
      previousScore: change?.previousScore ?? null,
      outcome: latest.outcome,
      siteAvailable: latest.siteAvailable,
      pagesScanned: latest.pagesScanned,
      detailsRetained: latest.detailsRetained,
    },
    counts: { critical: latest.criticalCount, warning: latest.warningCount, info: latest.infoCount ?? 0 },
    pages: await pageHealth(latest.id, latest.pagesScanned),
    // Same query, same ordering as the opportunities page; the dashboard simply
    // stops after the first few so the two can never disagree.
    topIssues: opportunities.slice(0, TOP_ISSUES),
    opportunityCount: opportunities.length,
  };
}

/**
 * Pages grouped by the worst issue found on each.
 *
 * A page counts once: critical beats warning, warning beats healthy. Pages the
 * site refused to serve are reported separately — they are an access
 * restriction, not an SEO fault, and lumping them in with failures would
 * misrepresent the dealership's own website.
 */
async function pageHealth(scanId: number, pagesScanned: number): Promise<ClientDashboard["pages"]> {
  const rows = (await db.execute<{ bucket: string; n: number }>(sql`
    with page_worst as (
      select p.id,
             p.result_class,
             max(case when i.severity = 'critical' then 2 when i.severity = 'warning' then 1 else 0 end) as worst
      from scan_pages p
      left join seo_issues i on i.page_id = p.id and i.scan_id = ${scanId}
      where p.scan_id = ${scanId}
      group by p.id, p.result_class
    )
    select case
             when result_class in ('BLOCKED', 'NOT_EVALUATED', 'SKIPPED') then 'not_evaluated'
             when worst = 2 then 'critical'
             when worst = 1 then 'warning'
             else 'healthy'
           end as bucket,
           count(*)::int as n
    from page_worst group by 1
  `)) as unknown as Array<{ bucket: string; n: number }>;
  const by = new Map(rows.map((r) => [r.bucket, Number(r.n)]));
  const critical = by.get("critical") ?? 0;
  const warning = by.get("warning") ?? 0;
  const notEvaluated = by.get("not_evaluated") ?? 0;
  const healthy = by.get("healthy") ?? 0;
  return { total: healthy + warning + critical + notEvaluated || pagesScanned, healthy, warning, critical, notEvaluated };
}
