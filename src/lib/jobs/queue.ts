import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, type Job } from "@/lib/db/schema";

/**
 * Postgres-backed job queue.
 *
 *  - `FOR UPDATE SKIP LOCKED` lets any number of cron invocations / workers
 *    pull jobs concurrently without double-processing.
 *  - A partial unique index on `dedupe_key` (queued/running only) prevents
 *    duplicate scans for the same dealership.
 *  - Long jobs (SEO scans) are resumable: a handler that runs out of time
 *    returns `done: false` and the job is re-queued without counting as a
 *    failed attempt; the next tick continues where it stopped.
 */

export type JobType = Job["type"];

export async function enqueueJob(input: {
  type: JobType;
  dealershipId?: number | null;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  priority?: number;
  runAfter?: Date;
  maxAttempts?: number;
  /** Crawler region (SEO scans). */
  region?: string | null;
}): Promise<number | null> {
  const rows = await db
    .insert(jobs)
    .values({
      type: input.type,
      dealershipId: input.dealershipId ?? null,
      payload: input.payload ?? {},
      dedupeKey: input.dedupeKey ?? null,
      priority: input.priority ?? 100,
      runAfter: input.runAfter ?? new Date(),
      maxAttempts: input.maxAttempts ?? 3,
      region: input.region ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: jobs.id });
  return rows[0]?.id ?? null;
}

export interface ClaimFilter {
  /** Job types this runner handles (undefined = all). */
  types?: JobType[];
  /** Regions this runner crawls for; SEO scan jobs are only claimed in these regions. */
  regions: string[];
  /** Region assumed for jobs without one. */
  defaultRegion: string;
}

export async function claimNextJob(workerId: string, filter: ClaimFilter): Promise<Job | null> {
  const typeCond = filter.types ? sql`and type::text in (${sql.join(filter.types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const regionCond = filter.regions.length
    ? sql`and (type <> 'seo_scan' or coalesce(region, ${filter.defaultRegion}) in (${sql.join(filter.regions.map((r) => sql`${r}`), sql`, `)}))`
    : sql`and type <> 'seo_scan'`;
  const result = await db.execute<Record<string, unknown>>(sql`
    update ${jobs} set
      status = 'running',
      locked_at = now(),
      locked_by = ${workerId},
      started_at = coalesce(started_at, now())
    where id = (
      select id from ${jobs}
      where status = 'queued' and run_after <= now() ${typeCond} ${regionCond}
      order by priority asc, run_after asc, id asc
      for update skip locked
      limit 1
    )
    returning id
  `);
  const id = (result as unknown as Array<{ id: number | string }>)[0]?.id;
  if (id === undefined) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, Number(id))).limit(1);
  return job ?? null;
}

export async function completeJob(id: number, result?: Record<string, unknown>) {
  await db
    .update(jobs)
    .set({ status: "completed", completedAt: new Date(), lockedAt: null, lockedBy: null, result: result ?? null, lastError: null })
    .where(eq(jobs.id, id));
}

/** Re-queue a resumable job that made progress but has more work to do. */
export async function continueJob(id: number, delayMs = 0) {
  await db
    .update(jobs)
    .set({ status: "queued", lockedAt: null, lockedBy: null, runAfter: new Date(Date.now() + delayMs) })
    .where(eq(jobs.id, id));
}

/** Record a failed attempt; retries with exponential backoff until maxAttempts. */
export async function failJobAttempt(job: Job, error: string): Promise<{ final: boolean }> {
  const attempts = job.attempts + 1;
  const final = attempts >= job.maxAttempts;
  await db
    .update(jobs)
    .set({
      status: final ? "failed" : "queued",
      attempts,
      lastError: error.slice(0, 4000),
      lockedAt: null,
      lockedBy: null,
      runAfter: final ? job.runAfter : new Date(Date.now() + Math.min(60, 2 ** attempts) * 60_000),
      completedAt: final ? new Date() : null,
    })
    .where(eq(jobs.id, job.id));
  return { final };
}

/**
 * Jobs left "running" by an invocation that was killed (timeout, deploy)
 * are returned to the queue. Counts as an attempt so a job that always
 * crashes its worker eventually fails instead of looping forever.
 */
export async function recoverStaleJobs(staleAfterMs: number): Promise<Job[]> {
  const cutoff = new Date(Date.now() - staleAfterMs);
  const stale = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, "running"), lt(jobs.lockedAt, cutoff)));
  const finalFailures: Job[] = [];
  for (const job of stale) {
    const { final } = await failJobAttempt(job, "Job was interrupted (worker timed out or restarted).");
    if (final) finalFailures.push(job);
  }
  return finalFailures;
}
