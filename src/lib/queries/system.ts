import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlerWorkers, dealerships, emailReports, jobs, seoScans, systemLogs, userDealerships, users } from "@/lib/db/schema";
import { STALE_CRAWLER_HOURS } from "@/lib/jobs/maintenance";
import { getSettings } from "@/lib/settings";

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

/** What `status` really means, once a pending retry is taken into account. */
export type EmailOutcome = "accepted" | "failed" | "retrying" | "skipped" | "queued";

/**
 * Recent delivery attempts, each with an outcome the page can state honestly.
 *
 * Two distinctions matter here. First, `sent` means the provider *accepted* the
 * message — SMTP cannot confirm it reached an inbox — so it is reported as
 * "accepted", never as delivered. Second, a row sitting at `failed` while its
 * job is still queued is not a final outcome; it is a retry in progress.
 *
 * The retry is established, not guessed: every retryable email is keyed on its
 * job's dedupe key plus a per-recipient suffix (`alert:12` → `alert:12:a@b.c`),
 * so a live job whose key prefixes this row's key is that row's next attempt.
 */
export async function getRecentEmails(limit = 50, status?: EmailOutcome) {
  const rows = await db
    .select({
      email: emailReports,
      retryPending: sql<boolean>`exists (
        select 1 from ${jobs} j
        where j.status in ('queued', 'running')
          and ${emailReports.dedupeKey} like j.dedupe_key || ':%'
      )`,
    })
    .from(emailReports)
    .orderBy(desc(emailReports.createdAt))
    .limit(status ? 400 : limit);

  const mapped = rows.map((r) => ({
    ...r.email,
    outcome: (r.email.status === "sent"
      ? "accepted"
      : r.email.status === "skipped"
        ? "skipped"
        : r.email.status === "pending"
          ? "queued"
          : r.retryPending
            ? "retrying"
            : "failed") as EmailOutcome,
  }));
  return status ? mapped.filter((m) => m.outcome === status).slice(0, limit) : mapped;
}

/** Counts for the delivery summary, so a failure is visible without scrolling. */
export async function getEmailOutcomeCounts(): Promise<Record<EmailOutcome, number>> {
  const all = await getRecentEmails(400);
  const out: Record<EmailOutcome, number> = { accepted: 0, failed: 0, retrying: 0, skipped: 0, queued: 0 };
  for (const e of all) out[e.outcome]++;
  return out;
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
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, isActive: users.isActive, lastLoginAt: users.lastLoginAt, createdAt: users.createdAt, totpEnabledAt: users.totpEnabledAt })
    .from(users)
    .orderBy(users.name);
}

/** Dealership assignments for every client account, keyed by user id. */
export async function getDealershipAssignments(): Promise<Map<number, number[]>> {
  const rows = await db.select({ userId: userDealerships.userId, dealershipId: userDealerships.dealershipId }).from(userDealerships);
  const byUser = new Map<number, number[]>();
  for (const r of rows) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.dealershipId]);
  return byUser;
}

/**
 * Whether anyone is configured to receive email, and how many sends have
 * already been skipped because nobody was.
 *
 * A dealership is "covered" when it has its own notification address or when a
 * management recipient exists. Reported so the admin surfaces can say plainly
 * that alerting is switched off, which is otherwise invisible: an email with no
 * recipients used to look exactly like a successful one.
 */
export async function getEmailRecipientHealth() {
  const s = await getSettings();
  const managementCount = s.managementRecipients.length;
  const rows = await db
    .select({ id: dealerships.id, name: dealerships.name, notificationEmails: dealerships.notificationEmails })
    .from(dealerships)
    .where(eq(dealerships.isActive, true));
  const uncovered = managementCount > 0 ? [] : rows.filter((d) => (d.notificationEmails ?? []).length === 0);
  const [skipped] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailReports)
    .where(and(eq(emailReports.status, "skipped"), sql`jsonb_array_length(${emailReports.recipients}) = 0`));
  return {
    managementCount,
    newsletterCount: s.newsletterRecipients.length,
    totalDealerships: rows.length,
    uncovered: uncovered.map((d) => ({ id: d.id, name: d.name })),
    skippedForNoRecipients: Number(skipped?.n ?? 0),
    /** True when nothing at all would be delivered today. */
    noRecipientsAtAll: managementCount === 0 && rows.every((d) => (d.notificationEmails ?? []).length === 0),
  };
}
