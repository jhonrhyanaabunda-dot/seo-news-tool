import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlerWorkers, dealerships, emailReports, jobs, seoScans, systemLogs, users } from "@/lib/db/schema";
import { STALE_CRAWLER_HOURS } from "@/lib/jobs/maintenance";

export async function getJobOverview() {
  const counts = await db.select({ status: jobs.status, n: sql<number>`count(*)::int` }).from(jobs).groupBy(jobs.status);
  const active = await db
    .select({ job: jobs, dealershipName: dealerships.name })
    .from(jobs)
    .leftJoin(dealerships, eq(dealerships.id, jobs.dealershipId))
    .where(inArray(jobs.status, ["queued", "running"]))
    .orderBy(jobs.priority, jobs.runAfter)
    .limit(50);
  const failed = await db
    .select({ job: jobs, dealershipName: dealerships.name })
    .from(jobs)
    .leftJoin(dealerships, eq(dealerships.id, jobs.dealershipId))
    .where(eq(jobs.status, "failed"))
    .orderBy(desc(jobs.completedAt))
    .limit(25);
  const [lastRun] = await db.select({ at: sql<Date | null>`max(${jobs.startedAt})` }).from(jobs);
  const lastJobStartedAt = lastRun?.at ? new Date(lastRun.at) : null;
  // No job has started for 3 hours → the scheduler is probably not being called.
  const generatedAt = Date.now();
  const schedulerStale = !lastJobStartedAt || generatedAt - lastJobStartedAt.getTime() > 3 * 3600_000;
  return { generatedAt, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])), active, failed, lastJobStartedAt, schedulerStale };
}

export async function getCrawlers() {
  const workers = await db
    .select()
    .from(crawlerWorkers)
    .where(sql`${crawlerWorkers.lastSeenAt} > now() - make_interval(hours => ${STALE_CRAWLER_HOURS}::int)`)
    .orderBy(crawlerWorkers.region, desc(crawlerWorkers.lastSeenAt))
    .limit(50);
  const waiting = await db
    .select({ region: jobs.region, n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(and(eq(jobs.type, "seo_scan"), inArray(jobs.status, ["queued", "running"])))
    .groupBy(jobs.region);
  return { workers, waiting };
}

export async function getRecentScanFailures() {
  return db
    .select({ scan: seoScans, dealershipName: dealerships.name })
    .from(seoScans)
    .innerJoin(dealerships, eq(dealerships.id, seoScans.dealershipId))
    .where(eq(seoScans.status, "failed"))
    .orderBy(desc(seoScans.createdAt))
    .limit(25);
}

export async function getSystemLogs(limit = 100) {
  return db.select().from(systemLogs).orderBy(desc(systemLogs.createdAt)).limit(limit);
}

export async function getRecentEmails(limit = 50) {
  return db.select().from(emailReports).orderBy(desc(emailReports.createdAt)).limit(limit);
}

/** The error from the most recent failed test email, to show where the test was sent from. */
export async function getLastTestEmailError(): Promise<string | null> {
  const [row] = await db
    .select({ error: emailReports.error })
    .from(emailReports)
    .where(and(eq(emailReports.kind, "test"), eq(emailReports.status, "failed")))
    .orderBy(desc(emailReports.createdAt))
    .limit(1);
  return row?.error ?? null;
}

export async function getUsers() {
  return db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, isActive: users.isActive, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt })
    .from(users)
    .orderBy(users.name);
}
