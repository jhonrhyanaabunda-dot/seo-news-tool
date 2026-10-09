import "server-only";
import { cache } from "react";
import { and, asc, count, desc, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships, newsArticles, newsKeywords, reports, scanEvents, scanPages, seoChecks, seoIssues, seoScans } from "@/lib/db/schema";

/**
 * Cached per request: the layout reads it to decide whether the route exists and
 * the page reads it again to render, and that should be one query, not two.
 */
export const getDealership = cache(async (id: number) => {
  const [d] = await db.select().from(dealerships).where(eq(dealerships.id, id)).limit(1);
  return d ?? null;
});

export async function getLatestScans(dealershipId: number) {
  const [latest] = await db
    .select()
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealershipId), eq(seoScans.status, "completed")))
    .orderBy(desc(seoScans.completedAt))
    .limit(1);
  // `stalled` is evaluated against the database clock — the same one that stamps
  // updated_at — so it stays correct regardless of the app server's time.
  const [active] = await db
    .select({
      scan: seoScans,
      stalled: sql<boolean>`${seoScans.updatedAt} < now() - interval '5 minutes'`,
    })
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealershipId), inArray(seoScans.status, ["queued", "crawling", "finalizing"])))
    .limit(1);
  const [lastAttempt] = await db.select().from(seoScans).where(eq(seoScans.dealershipId, dealershipId)).orderBy(desc(seoScans.createdAt)).limit(1);
  return {
    latest: latest ?? null,
    active: active ? { ...active.scan, stalled: active.stalled } : null,
    lastAttempt: lastAttempt ?? null,
  };
}

export async function getScanProgress(scanId: number) {
  const [row] = await db
    .select({
      total: count(),
      done: sql<number>`count(*) filter (where ${scanPages.status} <> 'pending')::int`,
    })
    .from(scanPages)
    .where(eq(scanPages.scanId, scanId));
  return row ?? { total: 0, done: 0 };
}

/** How many pages in this scan had to be read with a real browser after a plain request was refused. */
export async function getRenderedPageCount(scanId: number) {
  const [row] = await db
    .select({ n: sql<number>`count(*) filter (where ${scanPages.fetchMethod} = 'browser')::int` })
    .from(scanPages)
    .where(eq(scanPages.scanId, scanId));
  return row?.n ?? 0;
}

export async function getChecks(scanId: number) {
  return db.select().from(seoChecks).where(eq(seoChecks.scanId, scanId)).orderBy(desc(seoChecks.pointsDeducted), asc(seoChecks.label));
}

export async function getIssueCounts(scanId: number) {
  const rows = await db
    .select({ severity: seoIssues.severity, category: seoIssues.category, n: sql<number>`count(*)::int` })
    .from(seoIssues)
    .where(eq(seoIssues.scanId, scanId))
    .groupBy(seoIssues.severity, seoIssues.category);
  const bySeverity: Record<string, number> = { critical: 0, warning: 0, info: 0 };
  const byCategory: Record<string, number> = {};
  for (const r of rows) {
    bySeverity[r.severity] += r.n;
    byCategory[r.category] = (byCategory[r.category] ?? 0) + r.n;
  }
  return { bySeverity, byCategory };
}

export async function getIssues(scanId: number, opts: { severity?: string; category?: string; pageId?: number; onlyNew?: boolean; page: number; pageSize: number }) {
  const where: SQL[] = [eq(seoIssues.scanId, scanId)];
  if (opts.severity && ["critical", "warning", "info"].includes(opts.severity)) where.push(eq(seoIssues.severity, opts.severity as "critical" | "warning" | "info"));
  if (opts.category) where.push(eq(seoIssues.category, opts.category));
  if (opts.pageId) where.push(eq(seoIssues.pageId, opts.pageId));
  if (opts.onlyNew) where.push(eq(seoIssues.isNew, true));
  const cond = and(...where);
  const [{ total }] = await db.select({ total: count() }).from(seoIssues).where(cond);
  const rows = await db
    .select()
    .from(seoIssues)
    .where(cond)
    .orderBy(sql`case ${seoIssues.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`, asc(seoIssues.checkKey), asc(seoIssues.url))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { rows, total };
}

export async function getPages(scanId: number, opts: { filter?: string; page: number; pageSize: number }) {
  const where: SQL[] = [eq(scanPages.scanId, scanId), ne(scanPages.status, "pending")];
  if (opts.filter === "issues") where.push(sql`${scanPages.issueCount} > 0`);
  else if (opts.filter === "errors") where.push(sql`(${scanPages.status} = 'failed' or ${scanPages.httpStatus} >= 400) and coalesce(${scanPages.errorCode}, '') <> 'BLOCKED'`);
  else if (opts.filter === "not_evaluated") where.push(sql`${scanPages.errorCode} in ('BLOCKED', 'NOT_EVALUATED')`);
  else if (opts.filter === "noindex") where.push(eq(scanPages.indexable, false));
  else if (opts.filter !== "all") where.push(ne(scanPages.status, "skipped"));
  const cond = and(...where);
  const [{ total }] = await db.select({ total: count() }).from(scanPages).where(cond);
  const rows = await db
    .select()
    .from(scanPages)
    .where(cond)
    .orderBy(desc(scanPages.isImportant), asc(scanPages.depth), asc(scanPages.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { rows, total };
}

export async function getScanHistory(dealershipId: number, limit = 60) {
  return db
    .select({
      id: seoScans.id,
      status: seoScans.status,
      outcome: seoScans.outcome,
      pagesBlocked: seoScans.pagesBlocked,
      pagesNotEvaluated: seoScans.pagesNotEvaluated,
      trigger: seoScans.trigger,
      websiteUrl: seoScans.websiteUrl,
      score: seoScans.score,
      criticalCount: seoScans.criticalCount,
      warningCount: seoScans.warningCount,
      infoCount: seoScans.infoCount,
      pagesScanned: seoScans.pagesScanned,
      siteAvailable: seoScans.siteAvailable,
      startedAt: seoScans.startedAt,
      completedAt: seoScans.completedAt,
      createdAt: seoScans.createdAt,
      errorMessage: seoScans.errorMessage,
      changeSummary: seoScans.changeSummary,
      detailsRetained: seoScans.detailsRetained,
      blockedReason: sql<string | null>`${seoScans.siteChecks}->>'blockedReason'`,
      auditMode: sql<string | null>`${seoScans.siteChecks}->>'auditMode'`,
    })
    .from(seoScans)
    .where(eq(seoScans.dealershipId, dealershipId))
    .orderBy(desc(seoScans.createdAt))
    .limit(limit);
}

export async function getScan(dealershipId: number, scanId: number) {
  const [s] = await db
    .select()
    .from(seoScans)
    .where(and(eq(seoScans.id, scanId), eq(seoScans.dealershipId, dealershipId)))
    .limit(1);
  return s ?? null;
}

export async function getScanEvents(scanId: number) {
  return db.select().from(scanEvents).where(eq(scanEvents.scanId, scanId)).orderBy(asc(scanEvents.createdAt)).limit(100);
}

export async function getKeywords(dealershipId: number) {
  return db.select().from(newsKeywords).where(eq(newsKeywords.dealershipId, dealershipId)).orderBy(asc(newsKeywords.kind), asc(newsKeywords.keyword));
}

/** Status counts for this store's own news; `brandNew` is unreviewed brand & industry context, reported separately. */
export async function getNewsCounts(dealershipId: number) {
  const rows = await db
    .select({ relevance: newsArticles.relevance, scope: newsArticles.scope, n: sql<number>`count(*)::int` })
    .from(newsArticles)
    .where(eq(newsArticles.dealershipId, dealershipId))
    .groupBy(newsArticles.relevance, newsArticles.scope);
  const out: Record<string, number> = { new: 0, relevant: 0, reviewed: 0, not_relevant: 0, brandNew: 0 };
  for (const r of rows) {
    if (r.scope === "dealership") out[r.relevance] += r.n;
    else if (r.relevance === "new") out.brandNew += r.n;
  }
  return out;
}

export async function hasAnyScoredScan(dealershipId: number) {
  const [r] = await db
    .select({ id: seoScans.id })
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealershipId), isNotNull(seoScans.score)))
    .limit(1);
  return Boolean(r);
}

/** URLs the website's security prevented the monitor from analysing, for the Protected Pages tab. */
export async function getProtectedPages(scanId: number) {
  return db
    .select({
      id: scanPages.id,
      url: scanPages.url,
      finalUrl: scanPages.finalUrl,
      status: scanPages.status,
      httpStatus: scanPages.httpStatus,
      errorCode: scanPages.errorCode,
      errorMessage: scanPages.errorMessage,
      redirected: scanPages.redirected,
      resultClass: scanPages.resultClass,
      fetchMethod: scanPages.fetchMethod,
      fetchedAt: scanPages.fetchedAt,
      pageType: scanPages.pageType,
    })
    .from(scanPages)
    .where(
      and(
        eq(scanPages.scanId, scanId),
        sql`(${scanPages.resultClass} in ('PROTECTED', 'ACCESS_DENIED', 'RATE_LIMITED', 'NOT_EVALUATED') or (${scanPages.resultClass} is null and ${scanPages.errorCode} in ('BLOCKED', 'NOT_EVALUATED')))`,
      ),
    )
    .orderBy(asc(scanPages.id))
    .limit(500);
}

export async function getReports(dealershipId: number) {
  return db
    .select({ id: reports.id, status: reports.status, generator: reports.generator, createdAt: reports.createdAt, completedAt: reports.completedAt, scanId: reports.scanId, error: reports.error })
    .from(reports)
    .where(eq(reports.dealershipId, dealershipId))
    .orderBy(desc(reports.createdAt))
    .limit(30);
}

export async function getReport(dealershipId: number, reportId: number) {
  const [r] = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, reportId), eq(reports.dealershipId, dealershipId)))
    .limit(1);
  return r ?? null;
}
