import "server-only";
import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships, newsArticles, scanPages, seoChecks, seoIssues, seoScans, type Dealership } from "@/lib/db/schema";
import { CATEGORIES, CHECKS_BY_KEY, type Category } from "@/lib/seo/checks/config";
import { OUTCOME_META, type ScanOutcome } from "@/lib/seo/outcome";
import { PRIORITY_ORDER, priorityFor, reportGroupFor } from "@/lib/seo/priority";
import { classifyPageResult, isAnalyzed, isProtected } from "@/lib/seo/result-class";
import { crawlJobStatus } from "@/lib/jobs/status";
import { getSettings } from "@/lib/settings";
import { REPORT_VERSION, type FindingArticle, type ReportFindings } from "./types";

const MAX_SAMPLE_URLS = 5;
const MAX_PROTECTED_LISTED = 50;
const MAX_ARTICLES_PER_GROUP = 10;
const NEWS_PERIOD_DAYS = 30;

/**
 * Everything a report may say, computed from stored crawl and news data by code.
 * Output is ordered deterministically and contains no clock values, so the same
 * data always produces the same findings (and the same input hash).
 */
export async function buildFindings(dealer: Dealership): Promise<ReportFindings | null> {
  const [scan] = await db
    .select()
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealer.id), eq(seoScans.status, "completed")))
    .orderBy(desc(seoScans.completedAt))
    .limit(1);
  if (!scan) return null;

  const pages = await db
    .select({ id: scanPages.id, url: scanPages.url, finalUrl: scanPages.finalUrl, status: scanPages.status, httpStatus: scanPages.httpStatus, errorCode: scanPages.errorCode, errorMessage: scanPages.errorMessage, redirected: scanPages.redirected, resultClass: scanPages.resultClass })
    .from(scanPages)
    .where(eq(scanPages.scanId, scan.id))
    .orderBy(asc(scanPages.id));
  // Older scans predate stored result classes; classify them the same way on read.
  const classified = pages.map((p) => ({ ...p, cls: p.resultClass ?? classifyPageResult(p) }));
  const protectedPages = classified.filter((p) => isProtected(p.cls));

  const issueRows = await db
    .select({
      checkKey: seoIssues.checkKey,
      severity: seoIssues.severity,
      affected: sql<number>`count(distinct ${seoIssues.url})::int`,
      urls: sql<string[]>`(array_agg(distinct ${seoIssues.url} order by ${seoIssues.url}))[1:${sql.raw(String(MAX_SAMPLE_URLS))}]`,
      example: sql<string>`min(${seoIssues.message})`,
    })
    .from(seoIssues)
    .where(eq(seoIssues.scanId, scan.id))
    .groupBy(seoIssues.checkKey, seoIssues.severity);

  const issues = issueRows
    .map((r) => {
      const def = CHECKS_BY_KEY[r.checkKey];
      return {
        checkKey: r.checkKey,
        title: def?.problem ?? r.checkKey,
        group: reportGroupFor(r.checkKey),
        priority: priorityFor(r.checkKey, r.severity),
        affectedPages: Number(r.affected),
        // Link checks record one issue per broken link (on the first page it was found), so they count links, not pages.
        unit: r.checkKey === "broken_internal_link" || r.checkKey === "broken_external_link" ? ("link" as const) : ("page" as const),
        sampleUrls: r.urls ?? [],
        example: r.example,
        recommendation: def?.recommendation ?? "",
      };
    })
    .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || b.affectedPages - a.affectedPages || a.checkKey.localeCompare(b.checkKey));

  const passed = await db
    .select({ checkKey: seoChecks.checkKey })
    .from(seoChecks)
    .where(and(eq(seoChecks.scanId, scan.id), eq(seoChecks.status, "pass")))
    .orderBy(asc(seoChecks.checkKey));

  const settings = await getSettings();
  const since = new Date((scan.completedAt ?? scan.createdAt).getTime() - NEWS_PERIOD_DAYS * 86_400_000);
  const articles = await db
    .select()
    .from(newsArticles)
    .where(and(eq(newsArticles.dealershipId, dealer.id), gte(newsArticles.detectedAt, since), ne(newsArticles.relevance, "not_relevant")))
    .orderBy(asc(newsArticles.sourcePriority), desc(newsArticles.relevanceScore), desc(newsArticles.publishedAt), asc(newsArticles.id))
    .limit(500);
  const toFinding = (a: (typeof articles)[number]): FindingArticle => ({
    id: a.id,
    title: a.title,
    source: a.source,
    url: a.url,
    publishedAt: a.publishedAt ? a.publishedAt.toISOString().slice(0, 10) : null,
    sourceType: a.sourceType,
    scope: a.scope,
    topics: a.topics,
    relevance: a.relevance,
  });
  const dealershipNews = articles.filter((a) => a.scope === "dealership");
  const manufacturerNews = articles.filter((a) => a.scope === "brand" && (a.sourceType === "manufacturer" || a.topics.some((t) => t === "recall" || t === "new_model" || t === "manufacturer")));
  const industryNews = articles.filter((a) => a.scope === "brand" && !manufacturerNews.includes(a) && a.topics.includes("industry"));

  const remote = scan.siteChecks?.auditMode === "remote";
  const ps = scan.siteChecks?.pagespeed;
  const outcome = (scan.outcome ?? "completed") as ScanOutcome;
  const categoryScores = Object.entries(scan.categoryScores ?? {})
    .map(([category, v]) => ({ category, label: CATEGORIES[category as Category]?.label ?? category, score: v.score }))
    .sort((a, b) => a.category.localeCompare(b.category));
  const change = scan.changeSummary;

  return {
    version: REPORT_VERSION,
    dealership: {
      id: dealer.id,
      name: dealer.name,
      websiteUrl: dealer.websiteUrl,
      brand: dealer.brand,
      location: [dealer.city, dealer.state].filter(Boolean).join(", ") || null,
      platform: dealer.websitePlatform ?? dealer.detectedPlatform ?? null,
    },
    scan: {
      id: scan.id,
      completedAt: scan.completedAt?.toISOString() ?? null,
      status: crawlJobStatus(scan),
      outcomeLabel: OUTCOME_META[outcome]?.label ?? outcome,
      score: scan.score,
      categoryScores,
      pagesRequested: classified.filter((p) => p.cls !== null && p.cls !== "SKIPPED").length,
      pagesAnalyzed: classified.filter((p) => isAnalyzed(p.cls)).length,
      pagesProtected: protectedPages.length,
      siteAvailable: scan.siteAvailable,
      limitedHomepageCheckOnly: remote,
    },
    counts: {
      critical: issues.filter((i) => i.priority === "CRITICAL").length,
      high: issues.filter((i) => i.priority === "HIGH").length,
      medium: issues.filter((i) => i.priority === "MEDIUM").length,
      low: issues.filter((i) => i.priority === "LOW").length,
      passedChecks: passed.length,
    },
    issues,
    passedChecks: passed.map((p) => ({ checkKey: p.checkKey, label: CHECKS_BY_KEY[p.checkKey]?.label ?? p.checkKey, group: reportGroupFor(p.checkKey) })),
    protectedPages: {
      total: protectedPages.length,
      items: protectedPages.slice(0, MAX_PROTECTED_LISTED).map((p) => ({ url: p.finalUrl ?? p.url, resultClass: p.cls!, reason: p.errorMessage })),
    },
    changes: change?.previousScanId ? { scoreDelta: change.scoreDelta, newIssues: change.newIssues.length, resolvedIssues: change.resolvedCount } : null,
    performance: ps && !ps.error ? { mobileScore: ps.performance, lcpMs: ps.lcpMs, cls: ps.cls } : null,
    news: {
      periodDays: NEWS_PERIOD_DAYS,
      newCount: dealershipNews.filter((a) => a.relevance === "new").length,
      relevantCount: dealershipNews.filter((a) => a.relevance === "relevant" || a.relevanceScore >= settings.newsAlertMinScore).length,
      dealership: dealershipNews.slice(0, MAX_ARTICLES_PER_GROUP).map(toFinding),
      manufacturer: manufacturerNews.slice(0, MAX_ARTICLES_PER_GROUP).map(toFinding),
      industry: industryNews.slice(0, MAX_ARTICLES_PER_GROUP).map(toFinding),
    },
  };
}

/** Identical findings under the same model and report version reuse the stored narrative. */
export function findingsHash(findings: ReportFindings, model: string): string {
  return createHash("sha256").update(JSON.stringify({ v: REPORT_VERSION, model, findings })).digest("hex");
}

export async function getDealershipForReport(id: number): Promise<Dealership | null> {
  const [d] = await db.select().from(dealerships).where(eq(dealerships.id, id)).limit(1);
  return d ?? null;
}
