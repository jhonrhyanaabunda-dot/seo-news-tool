import "server-only";
import { randomBytes } from "node:crypto";
import type { Job } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger, errorMessage } from "@/lib/logger";
import { dedicatedWorkerOnline, heartbeat, touchWorker } from "@/lib/crawler/heartbeat";
import { runSeoScanStep } from "@/lib/seo/scan-engine";
import { markScanFailed } from "@/lib/seo/scans";
import { runNewsScan } from "@/lib/news/monitor";
import { runIndustryNewsFetch } from "@/lib/news/seo-industry";
import { sendAlertEmail, sendDigests } from "@/lib/email/reports";
import { runMaintenance } from "./maintenance";
import { markReportFailed, runReportJob } from "@/lib/reports/service";
import { claimNextJob, completeJob, continueJob, failJobAttempt, recoverStaleJobs, type ClaimFilter, type JobType } from "./queue";
import { scheduleDueWork } from "./scheduler";

/** Stop claiming new jobs when less than this much time is left. */
const MIN_REMAINING_MS = 30_000;
/** A running job not heard from for this long is assumed dead (function killed). */
const STALE_AFTER_MS = 15 * 60_000;
const ALL_TYPES: JobType[] = ["seo_scan", "news_scan", "digest", "alert", "maintenance", "report", "industry_news"];

/**
 * Who is running the tick:
 *  - vercel  Vercel Cron / after(): runs everything, but SEO scans only when
 *            CRAWLER_MODE=vercel (functions pinned to the default US region).
 *  - worker  standalone crawler worker in WORKER_REGION; job types from WORKER_JOB_TYPES.
 *  - cli     local `npm run scan:once` (behaves like a worker in the default region).
 */
export type RunnerRole = "vercel" | "worker" | "cli";

export interface TickResult {
  workerId: string;
  role: RunnerRole;
  region: string;
  scheduled: Awaited<ReturnType<typeof scheduleDueWork>> | null;
  processed: number;
  completed: number;
  continued: number;
  failed: number;
  durationMs: number;
}

function resolveRunner(role: RunnerRole): { region: string; filter: ClaimFilter; crawls: boolean } {
  const e = env();
  const defaultRegion = e.DEFAULT_CRAWLER_REGION;
  if (role === "vercel") {
    const crawls = e.CRAWLER_MODE === "vercel";
    return { region: defaultRegion, crawls, filter: { types: crawls ? ALL_TYPES : ALL_TYPES.filter((t) => t !== "seo_scan"), regions: crawls ? [defaultRegion] : [], defaultRegion } };
  }
  const region = (role === "worker" ? e.WORKER_REGION : undefined) ?? defaultRegion;
  const wanted = e.WORKER_JOB_TYPES?.split(",").map((s) => s.trim()).filter((s): s is JobType => (ALL_TYPES as string[]).includes(s));
  const types = wanted && wanted.length ? wanted : ALL_TYPES;
  return { region, crawls: types.includes("seo_scan"), filter: { types, regions: [region], defaultRegion } };
}

/**
 * One unit of background work: schedule due items, then process queued jobs
 * in parallel until the time budget is spent. Called by the Vercel Cron
 * endpoint and, in a loop, by the regional crawler workers.
 */
export async function runTick(opts: { budgetMs: number; role: RunnerRole; workerId?: string; schedule?: boolean; concurrency?: number }): Promise<TickResult> {
  const started = Date.now();
  const deadline = started + opts.budgetMs;
  const resolved = resolveRunner(opts.role);
  const { region } = resolved;
  let { filter, crawls } = resolved;
  // A web-server tick never crawls while a dedicated worker is online: Chromium and large-page parsing in the
  // same process that renders the dashboard made every click wait behind the crawl. The worker picks the scan up
  // within its poll interval instead; if no worker is online, the web server still crawls as a fallback.
  if (opts.role === "vercel" && crawls && (await dedicatedWorkerOnline(region).catch(() => false))) {
    crawls = false;
    filter = { ...filter, types: (filter.types ?? ALL_TYPES).filter((t) => t !== "seo_scan"), regions: [] };
  }
  const workerId = opts.workerId ?? (opts.role === "vercel" ? `vercel-${region}` : `${opts.role}-${randomBytes(4).toString("hex")}`);
  const result: TickResult = { workerId, role: opts.role, region, scheduled: null, processed: 0, completed: 0, continued: 0, failed: 0, durationMs: 0 };
  const crawlerKind = opts.role === "vercel" ? "vercel" : opts.role === "cli" ? "cli" : "worker";

  if (crawls) await heartbeat(workerId, region, crawlerKind).catch(() => {});

  if (opts.schedule !== false) {
    try {
      result.scheduled = await scheduleDueWork();
    } catch (err) {
      await logger.error("scheduler", "Scheduling failed", { error: errorMessage(err) });
    }
  }

  try {
    const dead = await recoverStaleJobs(STALE_AFTER_MS);
    for (const job of dead) {
      if (job.type === "seo_scan" && typeof job.payload.scanId === "number") {
        await markScanFailed(job.payload.scanId, "The scan was interrupted repeatedly and could not be completed.");
      }
    }
  } catch (err) {
    await logger.error("jobs", "Stale job recovery failed", { error: errorMessage(err) });
  }

  const loop = async () => {
    while (deadline - Date.now() > MIN_REMAINING_MS) {
      const job = await claimNextJob(workerId, filter);
      if (!job) return;
      result.processed++;
      if (crawls && job.type === "seo_scan") await heartbeat(workerId, region, crawlerKind, job.id).catch(() => {});
      const outcome = await execute(job, deadline, { region, id: workerId });
      if (crawls) await heartbeat(workerId, region, crawlerKind, null, 1).catch(() => {});
      result[outcome]++;
      if (outcome === "continued") return; // out of time for this slot
    }
  };
  // Long scans outlast the online window; keep reporting so this crawler still counts as online mid-scan.
  const keepAlive = crawls ? setInterval(() => void touchWorker(workerId).catch(() => {}), 60_000) : null;
  try {
    await Promise.all(Array.from({ length: opts.concurrency ?? env().JOB_CONCURRENCY }, loop));
  } finally {
    if (keepAlive) clearInterval(keepAlive);
  }

  result.durationMs = Date.now() - started;
  return result;
}

async function execute(job: Job, deadline: number, crawler: { region: string; id: string }): Promise<"completed" | "continued" | "failed"> {
  try {
    switch (job.type) {
      case "seo_scan": {
        const scanId = Number(job.payload.scanId);
        const step = await runSeoScanStep(scanId, deadline, crawler);
        if (step.done) {
          await completeJob(job.id, { scanId, phase: step.phase, region: crawler.region, crawler: crawler.id });
          return "completed";
        }
        await continueJob(job.id, step.deferMs ?? 0);
        return "continued";
      }
      case "news_scan": {
        if (deadline - Date.now() < 60_000) {
          await continueJob(job.id);
          return "continued";
        }
        const r = await runNewsScan(Number(job.dealershipId));
        await completeJob(job.id, { ...r });
        return "completed";
      }
      case "industry_news": {
        const r = await runIndustryNewsFetch();
        await completeJob(job.id, { ...r });
        return "completed";
      }
      case "digest": {
        const kind = job.payload.kind === "weekly" ? "weekly" : "daily";
        const r = await sendDigests(kind, String(job.payload.periodKey));
        await completeJob(job.id, r);
        return "completed";
      }
      case "alert": {
        const r = await sendAlertEmail(Number(job.payload.alertId));
        await completeJob(job.id, r);
        return "completed";
      }
      case "maintenance": {
        const r = await runMaintenance();
        await completeJob(job.id, r);
        return "completed";
      }
      case "report": {
        // A model call can take a minute or two; don't start one that the time budget would cut off.
        if (deadline - Date.now() < 150_000) {
          await continueJob(job.id);
          return "continued";
        }
        const r = await runReportJob(Number(job.payload.reportId));
        await completeJob(job.id, { reportId: Number(job.payload.reportId), ...r });
        return "completed";
      }
      default:
        await completeJob(job.id, { skipped: "unknown job type" });
        return "completed";
    }
  } catch (err) {
    const message = errorMessage(err);
    const { final } = await failJobAttempt(job, message);
    await logger.error("jobs", `Job ${job.type} #${job.id} failed${final ? " permanently" : "; will retry"}`, { error: message, attempts: job.attempts + 1 }, job.dealershipId ?? undefined);
    if (final && job.type === "seo_scan") {
      await markScanFailed(Number(job.payload.scanId), `The scan stopped because of an unexpected error: ${message}`);
    }
    if (final && job.type === "report") {
      await markReportFailed(Number(job.payload.reportId), `The report could not be generated: ${message}`);
    }
    return "failed";
  }
}
