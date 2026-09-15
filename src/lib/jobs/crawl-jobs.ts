import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships, jobs, reports, scanPages, seoScans } from "@/lib/db/schema";
import { createScanAndJob } from "@/lib/seo/scans";
import { requestReport } from "@/lib/reports/service";
import { isSameSite } from "@/lib/seo/url";
import { enqueueJob } from "./queue";
import { crawlJobStatus, type CrawlJobStatus } from "./status";

/**
 * The provider-independent contract between the dashboard/API and crawlers.
 *
 * Creating a crawl job only writes to the queue; U.S. crawler workers (any host)
 * claim `seo_scan` jobs from Postgres and write results back. Nothing calls a
 * worker over HTTP, so workers can move between Railway, Render, Fly.io or AWS
 * without changing this API or the dashboard.
 */

export type CrawlJobType = "seo" | "news" | "report";

export interface CrawlJobView {
  id: number;
  jobType: CrawlJobType;
  dealershipId: number;
  status: CrawlJobStatus;
  createdAt: string;
  updatedAt: string | null;
  scan?: { id: number; outcome: string | null; score: number | null; pagesAnalyzed: number; pagesProtected: number; criticalIssues: number; warnings: number; completedAt: string | null };
  report?: { id: number; status: string; generator: string | null; completedAt: string | null };
  error: string | null;
}

export class CrawlJobError extends Error {
  constructor(
    message: string,
    public status: 404 | 409 | 422,
  ) {
    super(message);
  }
}

export async function createCrawlJob(input: { dealershipId: number; jobType: CrawlJobType; url?: string }): Promise<{ job: CrawlJobView; created: boolean }> {
  const [dealer] = await db.select().from(dealerships).where(eq(dealerships.id, input.dealershipId)).limit(1);
  if (!dealer) throw new CrawlJobError("Dealership not found.", 404);
  if (input.url) {
    // Jobs always cover the dealership's own website; the API never crawls arbitrary URLs.
    let sameSite = false;
    try {
      sameSite = isSameSite(new URL(dealer.websiteUrl), new URL(input.url));
    } catch {
      sameSite = false;
    }
    if (!sameSite) throw new CrawlJobError("url must belong to the dealership's website.", 422);
  }

  if (input.jobType === "seo") {
    if (!dealer.isActive || !dealer.seoEnabled) throw new CrawlJobError("SEO monitoring is disabled for this dealership.", 409);
    const scanId = await createScanAndJob(dealer.id, "manual");
    const [job] = await db
      .select()
      .from(jobs)
      .where(and(eq(jobs.type, "seo_scan"), eq(jobs.dealershipId, dealer.id)))
      .orderBy(desc(jobs.id))
      .limit(1);
    if (!job) throw new CrawlJobError("A scan could not be queued.", 409);
    return { job: await getCrawlJob(job.id).then((j) => j!), created: scanId !== null };
  }

  if (input.jobType === "news") {
    if (!dealer.isActive || !dealer.newsEnabled) throw new CrawlJobError("News monitoring is disabled for this dealership.", 409);
    const jobId = await enqueueJob({ type: "news_scan", dealershipId: dealer.id, dedupeKey: `news:${dealer.id}`, priority: 20 });
    const [job] = await db.select().from(jobs).where(and(eq(jobs.type, "news_scan"), eq(jobs.dealershipId, dealer.id))).orderBy(desc(jobs.id)).limit(1);
    if (!job) throw new CrawlJobError("A news check could not be queued.", 409);
    return { job: await getCrawlJob(job.id).then((j) => j!), created: jobId !== null };
  }

  const { reportId, queued } = await requestReport(dealer.id, null);
  const [job] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "report"), sql`(${jobs.payload}->>'reportId')::bigint = ${reportId}`))
    .orderBy(desc(jobs.id))
    .limit(1);
  if (!job) throw new CrawlJobError("A report is already being generated for this dealership.", 409);
  return { job: await getCrawlJob(job.id).then((j) => j!), created: queued };
}

function queueStatus(status: string): CrawlJobStatus {
  return status === "queued" ? "QUEUED" : status === "running" ? "RUNNING" : status === "completed" ? "COMPLETED" : "FAILED";
}

export async function getCrawlJob(jobId: number): Promise<CrawlJobView | null> {
  const [job] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job || !job.dealershipId || !["seo_scan", "news_scan", "report"].includes(job.type)) return null;
  const base = {
    id: job.id,
    dealershipId: job.dealershipId,
    createdAt: job.createdAt.toISOString(),
    updatedAt: (job.completedAt ?? job.startedAt)?.toISOString() ?? null,
    error: job.lastError,
  };

  if (job.type === "seo_scan") {
    const [scan] = await db.select().from(seoScans).where(eq(seoScans.id, Number(job.payload.scanId))).limit(1);
    if (!scan) return { ...base, jobType: "seo", status: queueStatus(job.status) };
    const [counts] = await db
      .select({
        analyzed: sql<number>`count(*) filter (where ${scanPages.resultClass} in ('SUCCESS','REDIRECT'))::int`,
        protected: sql<number>`count(*) filter (where ${scanPages.resultClass} in ('PROTECTED','ACCESS_DENIED','RATE_LIMITED','NOT_EVALUATED'))::int`,
      })
      .from(scanPages)
      .where(eq(scanPages.scanId, scan.id));
    return {
      ...base,
      jobType: "seo",
      status: crawlJobStatus(scan),
      error: scan.status === "failed" ? scan.errorMessage : null,
      scan: {
        id: scan.id,
        outcome: scan.outcome,
        score: scan.score,
        pagesAnalyzed: Number(counts?.analyzed ?? 0),
        pagesProtected: Number(counts?.protected ?? 0),
        criticalIssues: scan.criticalCount,
        warnings: scan.warningCount,
        completedAt: scan.completedAt?.toISOString() ?? null,
      },
    };
  }

  if (job.type === "report") {
    const [report] = await db.select().from(reports).where(eq(reports.id, Number(job.payload.reportId))).limit(1);
    const status: CrawlJobStatus = !report
      ? queueStatus(job.status)
      : report.status === "completed"
        ? "COMPLETED"
        : report.status === "failed"
          ? "FAILED"
          : report.status === "generating"
            ? "RUNNING"
            : "QUEUED";
    return {
      ...base,
      jobType: "report",
      status,
      error: report?.error ?? base.error,
      report: report ? { id: report.id, status: report.status, generator: report.generator, completedAt: report.completedAt?.toISOString() ?? null } : undefined,
    };
  }

  return { ...base, jobType: "news", status: queueStatus(job.status) };
}
