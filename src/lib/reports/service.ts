import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { reportRuns, reports, seoScans, type Report } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger, errorMessage } from "@/lib/logger";
import { enqueueJob } from "@/lib/jobs/queue";
import { recordSkippedNoRecipients, sendTrackedEmail } from "@/lib/email/send";
import { renderReportEmail } from "@/lib/email/templates";
import { getSettings } from "@/lib/settings";
import { aiReportsConfigured, generateAiNarrative } from "./ai";
import { buildFindings, findingsHash, getDealershipForReport } from "./findings";
import { deterministicNarrative, groundNarrative } from "./ground";
import type { ReportFindings, ReportNarrative } from "./types";
import { monthSummaryLine, reportedMonthFromKey } from "./monthly";

/**
 * Report lifecycle:
 *   request → queued job ("report") → build findings from the database →
 *   reuse a stored narrative for identical findings, or call the model once
 *   (within the monthly limit), or compose it deterministically → completed.
 *
 * Budget: each model call reserves a report_runs row under an advisory lock,
 * so parallel jobs cannot overshoot AI_REPORTS_MONTHLY_LIMIT. Reused and
 * deterministic reports make no model call and cost nothing.
 */

const BUDGET_LOCK_KEY = 823_410_517; // arbitrary constant for pg_advisory_xact_lock

export async function requestReport(dealershipId: number, requestedBy: number | null): Promise<{ reportId: number; queued: boolean }> {
  const [active] = await db
    .select({ id: reports.id })
    .from(reports)
    .where(and(eq(reports.dealershipId, dealershipId), sql`${reports.status} in ('queued', 'generating')`))
    .orderBy(desc(reports.createdAt))
    .limit(1);
  if (active) return { reportId: active.id, queued: false };
  const [row] = await db.insert(reports).values({ dealershipId, requestedBy, status: "queued" }).returning({ id: reports.id });
  const jobId = await enqueueJob({ type: "report", dealershipId, payload: { reportId: row.id }, dedupeKey: `report:${dealershipId}`, priority: 25, maxAttempts: 3 });
  if (jobId === null) {
    // A report job for this dealership is already queued; it will pick up the newest findings.
    await db.delete(reports).where(eq(reports.id, row.id));
    const [existing] = await db.select({ id: reports.id }).from(reports).where(eq(reports.dealershipId, dealershipId)).orderBy(desc(reports.createdAt)).limit(1);
    return { reportId: existing?.id ?? row.id, queued: false };
  }
  return { reportId: row.id, queued: true };
}

/** Model calls this UTC calendar month (reserved, succeeded, refused or invalid — every call that reached the model). */
export async function aiReportsUsedThisMonth(): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(reportRuns)
    .where(and(eq(reportRuns.provider, "anthropic"), ne(reportRuns.status, "error"), sql`${reportRuns.createdAt} >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`));
  return Number(r?.n ?? 0);
}

async function reserveModelCall(reportId: number, dealershipId: number, model: string): Promise<number | null> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BUDGET_LOCK_KEY})`);
    const [r] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(reportRuns)
      .where(and(eq(reportRuns.provider, "anthropic"), ne(reportRuns.status, "error"), sql`${reportRuns.createdAt} >= date_trunc('month', now() at time zone 'utc') at time zone 'utc'`));
    if (Number(r?.n ?? 0) >= env().AI_REPORTS_MONTHLY_LIMIT) return null;
    const [run] = await tx.insert(reportRuns).values({ reportId, dealershipId, provider: "anthropic", model, status: "pending" }).returning({ id: reportRuns.id });
    return run.id;
  });
}

/** Process a queued report. Throws only for transient failures worth a job retry. */
export async function runReportJob(reportId: number): Promise<{ status: string; generator: string | null }> {
  const [report] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1);
  if (!report || report.status === "completed") return { status: report?.status ?? "missing", generator: report?.generator ?? null };
  const dealer = await getDealershipForReport(report.dealershipId);
  if (!dealer) {
    await db.update(reports).set({ status: "failed", error: "Dealership no longer exists.", updatedAt: new Date() }).where(eq(reports.id, reportId));
    return { status: "failed", generator: null };
  }
  await db.update(reports).set({ status: "generating", updatedAt: new Date() }).where(eq(reports.id, reportId));

  const findings = await buildFindings(dealer);
  if (!findings) {
    await db.update(reports).set({ status: "failed", error: "No completed scan yet. Run a scan first, then generate the report.", updatedAt: new Date() }).where(eq(reports.id, reportId));
    return { status: "failed", generator: null };
  }
  const model = env().AI_REPORT_MODEL;
  const inputHash = findingsHash(findings, model);
  const finish = async (narrative: ReportNarrative, generator: "ai" | "deterministic", note: string | null) => {
    await db
      .update(reports)
      .set({ status: "completed", scanId: findings.scan.id, inputHash, findings, narrative, generator, generatorNote: note, error: null, completedAt: new Date(), updatedAt: new Date() })
      .where(eq(reports.id, reportId));
    return { status: "completed", generator };
  };

  // 1) Same findings as an earlier AI report: reuse it, no model call.
  const [previous] = await db
    .select({ id: reports.id, narrative: reports.narrative })
    .from(reports)
    .where(and(eq(reports.dealershipId, dealer.id), eq(reports.inputHash, inputHash), eq(reports.status, "completed"), eq(reports.generator, "ai"), ne(reports.id, reportId)))
    .orderBy(desc(reports.completedAt))
    .limit(1);
  if (previous?.narrative) return finish(previous.narrative as ReportNarrative, "ai", `Reused report #${previous.id}: the findings have not changed since it was written.`);

  // 2) No key configured, or the monthly limit is used up: compose from the findings.
  if (!aiReportsConfigured()) return finish(deterministicNarrative(findings), "deterministic", "AI summaries are not configured (ANTHROPIC_API_KEY); this report was composed directly from the findings.");
  const runId = await reserveModelCall(reportId, dealer.id, model);
  if (runId === null) return finish(deterministicNarrative(findings), "deterministic", `The monthly limit of ${env().AI_REPORTS_MONTHLY_LIMIT} AI reports has been reached; this report was composed directly from the findings.`);

  // 3) One model call; everything it returns is checked against the findings.
  const started = Date.now();
  try {
    const result = await generateAiNarrative(findings);
    await db
      .update(reportRuns)
      .set({ status: result.status, model: result.model.slice(0, 60), inputTokens: result.inputTokens, outputTokens: result.outputTokens, cacheReadTokens: result.cacheReadTokens, durationMs: Date.now() - started, error: result.error })
      .where(eq(reportRuns.id, runId));
    if (result.status !== "succeeded" || !result.narrative) {
      return finish(deterministicNarrative(findings), "deterministic", `${result.error ?? "The AI summary was not usable."} This report was composed directly from the findings.`);
    }
    const grounded = groundNarrative(result.narrative, findings);
    if (grounded.discarded.length) await logger.warn("reports", "Discarded AI report content that did not match the findings", { reportId, discarded: grounded.discarded }, dealer.id);
    return finish(grounded, "ai", null);
  } catch (err) {
    const message = errorMessage(err);
    await db.update(reportRuns).set({ status: "error", durationMs: Date.now() - started, error: message.slice(0, 2000) }).where(eq(reportRuns.id, runId));
    // Rate limits, overload and network failures are worth a job retry; request/auth errors are not.
    const transient = err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError;
    if (transient) {
      await db.update(reports).set({ status: "queued", updatedAt: new Date() }).where(eq(reports.id, reportId));
      throw err;
    }
    await logger.error("reports", "AI report generation failed", { reportId, error: message }, dealer.id);
    return finish(deterministicNarrative(findings), "deterministic", "The AI service could not be used for this report; it was composed directly from the findings.");
  }
}

/** Mark a report failed after its job exhausted its retries. */
export async function markReportFailed(reportId: number, message: string) {
  await db.update(reports).set({ status: "failed", error: message.slice(0, 2000), updatedAt: new Date() }).where(and(eq(reports.id, reportId), ne(reports.status, "completed")));
}

/** The report email for one report, shared by the on-demand send and the monthly report. */
function buildReportEmail(report: Report, dealer: NonNullable<Awaited<ReturnType<typeof getDealershipForReport>>>, monthly?: { label: string; line: string }) {
  const findings = report.findings as ReportFindings;
  const narrative = report.narrative as ReportNarrative;
  const base = env().APP_URL.replace(/\/$/, "");
  return renderReportEmail({
    dealershipName: dealer.name,
    websiteUrl: dealer.websiteUrl,
    score: findings.scan.score,
    statusLabel: findings.scan.status,
    pagesAnalyzed: findings.scan.pagesAnalyzed,
    pagesProtected: findings.scan.pagesProtected,
    executiveSummary: narrative.executiveSummary,
    actions: narrative.recommendedActions.map((a) => ({ priority: a.priority, title: a.title, action: a.action })),
    protectedPagesNote: narrative.protectedPagesNote,
    newsSummary: narrative.newsSummary,
    reportUrl: `${base}/dealerships/${dealer.id}?tab=reports&report=${report.id}`,
    dashboardUrl: base,
    ...(monthly ? { period: monthly.label, periodLine: monthly.line } : {}),
  });
}

export async function emailReport(report: Report): Promise<{ sent: number; failed: number; skipped: number; recipients: number }> {
  const dealer = await getDealershipForReport(report.dealershipId);
  if (!dealer || report.status !== "completed" || !report.findings || !report.narrative) return { sent: 0, failed: 0, skipped: 0, recipients: 0 };
  const settings = await getSettings();
  const recipients = [...new Set([...dealer.notificationEmails, ...settings.managementRecipients].map((e) => e.toLowerCase()))];
  const email = buildReportEmail(report, dealer);
  const out = { sent: 0, failed: 0, skipped: 0, recipients: recipients.length };
  for (const to of recipients) {
    const r = await sendTrackedEmail({ dedupeKey: `report:${report.id}:${to}`, kind: "report", dealershipId: dealer.id, to, subject: email.subject, html: email.html, text: email.text, payload: { reportId: report.id } });
    out[r]++;
  }
  return out;
}

/* ───────────────────────────── monthly report ───────────────────────────── */

/** Queue this month's report for one dealership; one per dealership per month (job dedupe key). */
export async function requestMonthlyReport(dealershipId: number, monthKey: string): Promise<boolean> {
  const [row] = await db.insert(reports).values({ dealershipId, requestedBy: null, status: "queued" }).returning({ id: reports.id });
  const jobId = await enqueueJob({ type: "report", dealershipId, payload: { reportId: row.id, monthly: monthKey }, dedupeKey: `monthly-report:${monthKey}:${dealershipId}`, priority: 40, maxAttempts: 3 });
  if (jobId === null) await db.delete(reports).where(eq(reports.id, row.id));
  return jobId !== null;
}

/** The month line: latest score against the last good scan before the month began. */
async function monthlyLine(dealershipId: number, report: Report, monthKey: string): Promise<{ label: string; line: string }> {
  const { label, start } = reportedMonthFromKey(monthKey);
  const [before] = await db
    .select({ score: seoScans.score })
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealershipId), eq(seoScans.status, "completed"), sql`${seoScans.outcome} is distinct from 'blocked'`, lt(seoScans.completedAt, start)))
    .orderBy(desc(seoScans.completedAt))
    .limit(1);
  return { label, line: monthSummaryLine(label, (report.findings as ReportFindings).scan.score, before?.score ?? null) };
}

/**
 * Email a completed monthly report to the dealership's recipients and management.
 * Idempotent per month and recipient, so a retried job never sends twice. Throws
 * when a send fails, so the job retries the rest.
 */
export async function emailMonthlyReport(reportId: number, monthKey: string): Promise<{ sent: number; skipped: number; recipients: number }> {
  const [report] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1);
  if (!report || report.status !== "completed" || !report.findings || !report.narrative) return { sent: 0, skipped: 0, recipients: 0 };
  const dealer = await getDealershipForReport(report.dealershipId);
  if (!dealer) return { sent: 0, skipped: 0, recipients: 0 };
  const settings = await getSettings();
  const recipients = [...new Set([...dealer.notificationEmails, ...settings.managementRecipients].map((e) => e.toLowerCase()))];
  const email = buildReportEmail(report, dealer, await monthlyLine(dealer.id, report, monthKey));
  if (recipients.length === 0) {
    await recordSkippedNoRecipients({
      dedupeKey: `monthly-report:${monthKey}:${dealer.id}:no-recipients`,
      kind: "report",
      dealershipId: dealer.id,
      subject: email.subject,
      reason: `No email recipients for ${dealer.name}. Add notification emails to the dealership, or management recipients in Settings.`,
      payload: { reportId: report.id, month: monthKey },
    });
    return { sent: 0, skipped: 1, recipients: 0 };
  }
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const to of recipients) {
    const r = await sendTrackedEmail({ dedupeKey: `monthly-report:${monthKey}:${dealer.id}:${to}`, kind: "report", dealershipId: dealer.id, to, subject: email.subject, html: email.html, text: email.text, payload: { reportId: report.id, month: monthKey } });
    if (r === "sent") sent++;
    else if (r === "skipped") skipped++;
    else failed++;
  }
  if (failed > 0) throw new Error(`${failed} monthly report email(s) failed to send; they will be retried.`);
  return { sent, skipped, recipients: recipients.length };
}

/** An admin's preview: one dealership's latest completed report as the monthly email, sent to one address. */
export async function sendMonthlyReportPreview(to: string, requestedBy: number): Promise<"sent" | "skipped" | "failed" | "no-report"> {
  const [report] = await db.select().from(reports).where(eq(reports.status, "completed")).orderBy(desc(reports.completedAt)).limit(1);
  if (!report?.findings || !report.narrative) return "no-report";
  const dealer = await getDealershipForReport(report.dealershipId);
  if (!dealer) return "no-report";
  const { key } = reportedMonthFromKey(new Date().toISOString().slice(0, 7));
  const email = buildReportEmail(report, dealer, await monthlyLine(dealer.id, report, key));
  return sendTrackedEmail({ dedupeKey: `monthly-preview:${requestedBy}:${Date.now()}`, kind: "test", to, subject: `[Preview] ${email.subject}`, html: email.html, text: email.text });
}
