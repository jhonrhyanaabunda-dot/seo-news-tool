import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { emailReports, type EmailReport } from "@/lib/db/schema";
import { logger, errorMessage } from "@/lib/logger";
import { getEmailProvider } from "./provider";

/**
 * Send an email exactly once per dedupe key. A row is written before sending;
 * if a previous attempt already succeeded the send is skipped, so job retries
 * and overlapping cron ticks never produce duplicate emails.
 */
export async function sendTrackedEmail(input: {
  dedupeKey: string;
  kind: EmailReport["kind"];
  dealershipId?: number | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  payload?: Record<string, unknown>;
  periodStart?: Date;
  periodEnd?: Date;
}): Promise<"sent" | "skipped" | "failed"> {
  const inserted = await db
    .insert(emailReports)
    .values({
      kind: input.kind,
      dealershipId: input.dealershipId ?? null,
      recipients: [input.to],
      subject: input.subject.slice(0, 500),
      dedupeKey: input.dedupeKey.slice(0, 200),
      status: "pending",
      payload: input.payload,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
    })
    .onConflictDoNothing()
    .returning({ id: emailReports.id });
  let id = inserted[0]?.id;
  if (!id) {
    const [existing] = await db.select().from(emailReports).where(eq(emailReports.dedupeKey, input.dedupeKey.slice(0, 200))).limit(1);
    if (!existing || existing.status === "sent" || existing.status === "skipped") return "skipped";
    id = existing.id;
  }
  try {
    const { id: providerId } = await getEmailProvider().send({ to: input.to, subject: input.subject, html: input.html, text: input.text, idempotencyKey: input.dedupeKey.slice(0, 200) });
    await db.update(emailReports).set({ status: "sent", sentAt: new Date(), providerMessageId: providerId, error: null }).where(eq(emailReports.id, id));
    return "sent";
  } catch (err) {
    await db.update(emailReports).set({ status: "failed", error: errorMessage(err).slice(0, 2000) }).where(eq(emailReports.id, id));
    await logger.error("email", "Email delivery failed", { to: input.to, subject: input.subject, error: errorMessage(err) }, input.dealershipId ?? undefined);
    return "failed";
  }
}

/**
 * Record that an email could not be sent because nobody was configured to
 * receive it.
 *
 * Writing the row matters: without it an empty recipient list produced
 * "0 sent, 0 failed", which every caller read as success, so alerting could be
 * switched off by clearing one settings field and nothing would ever say so.
 * The row carries an empty recipient list and an explanation, and is keyed like
 * any other send so a retry does not pile up duplicates.
 */
export async function recordSkippedNoRecipients(input: {
  dedupeKey: string;
  kind: EmailReport["kind"];
  dealershipId?: number | null;
  subject: string;
  reason: string;
  payload?: Record<string, unknown>;
}): Promise<"skipped"> {
  await db
    .insert(emailReports)
    .values({
      kind: input.kind,
      dealershipId: input.dealershipId ?? null,
      recipients: [],
      subject: input.subject.slice(0, 500),
      dedupeKey: input.dedupeKey.slice(0, 200),
      status: "skipped",
      error: input.reason.slice(0, 2000),
      payload: input.payload,
    })
    .onConflictDoNothing();
  await logger.warn("email", "Email not sent: no recipients configured", { kind: input.kind, subject: input.subject, reason: input.reason }, input.dealershipId ?? undefined);
  return "skipped";
}
