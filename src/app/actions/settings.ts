"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { db } from "@/lib/db";
import { jobs } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { sendTrackedEmail } from "@/lib/email/send";
import { renderTestEmail } from "@/lib/email/templates";
import { sendNewsletterPreview } from "@/lib/email/reports";
import { kickProcessing } from "@/lib/jobs/kick";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { parseEmailList } from "@/lib/security/sanitize";
import { getSettings, saveSettings } from "@/lib/settings";
import { changedKeys, recordAudit } from "@/lib/audit";

export type SettingsState = { error?: string; ok?: boolean } | undefined;

const bool = (v: FormDataEntryValue | null) => v === "on" || v === "true";

export async function saveSettingsAction(_prev: SettingsState, formData: FormData): Promise<SettingsState> {
  const user = await assertAdmin();
  const emails = parseEmailList(String(formData.get("managementRecipients") ?? ""));
  const newsletterEmails = parseEmailList(String(formData.get("newsletterRecipients") ?? ""));
  const invalid = [...emails.invalid, ...newsletterEmails.invalid];
  if (invalid.length) return { error: `These addresses are not valid: ${invalid.join(", ")}` };
  const input = z
    .object({
      seoIntervalHours: z.coerce.number().int().min(1).max(720),
      newsIntervalHours: z.coerce.number().int().min(1).max(168),
      dailyDigestHour: z.coerce.number().int().min(0).max(23),
      weeklyDigestWeekday: z.coerce.number().int().min(0).max(6),
      weeklyDigestHour: z.coerce.number().int().min(0).max(23),
      scoreChangeThreshold: z.coerce.number().int().min(1).max(50),
      newsAlertMinScore: z.coerce.number().int().min(1).max(100),
      newsLookbackDays: z.coerce.number().int().min(1).max(90),
      retentionDays: z.coerce.number().int().min(14).max(1095),
      monthlyReportDay: z.coerce.number().int().min(1).max(28),
      monthlyReportHour: z.coerce.number().int().min(0).max(23),
    })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Please check the highlighted values: " + input.error.issues.map((i) => `${String(i.path[0])} ${i.message.toLowerCase()}`).join("; ") };
  const requireAdminMfa = bool(formData.get("requireAdminMfa"));
  // Turning the requirement on from an account without two-factor would lock
  // the person saving out of this very page.
  if (requireAdminMfa && !user.mfaEnabled) return { error: "Set up two-factor sign-in on your own account (Account page) before requiring it for administrators." };
  const before = await getSettings();
  const after = await saveSettings({
    ...input.data,
    dailyDigestEnabled: bool(formData.get("dailyDigestEnabled")),
    weeklyDigestEnabled: bool(formData.get("weeklyDigestEnabled")),
    sendDigestWhenNoChanges: bool(formData.get("sendDigestWhenNoChanges")),
    instantAlertsEnabled: bool(formData.get("instantAlertsEnabled")),
    schedulerPaused: bool(formData.get("schedulerPaused")),
    requireAdminMfa,
    monthlyReportEnabled: bool(formData.get("monthlyReportEnabled")),
    managementRecipients: emails.valid,
    newsletterRecipients: newsletterEmails.valid,
  });
  await logger.info("admin", "Settings updated", { by: user.email });
  await recordAudit({
    actor: user,
    action: "settings.update",
    target: { type: "settings", id: "app" },
    summary: "Updated application settings",
    details: { changed: changedKeys(before, after) },
  });
  revalidatePath("/admin/settings");
  return { ok: true };
}

export async function sendTestEmailAction(formData: FormData) {
  const user = await assertAdmin();
  const to = parseEmailList(String(formData.get("to") ?? user.email)).valid[0] ?? user.email;
  const limit = await checkRateLimit({ key: `test-email:${user.id}`, limit: 5, windowSeconds: 3600 });
  if (!limit.allowed) redirect("/admin/settings?notice=rate-limited");
  const { subject, html, text } = renderTestEmail(env().APP_URL);
  const r = await sendTrackedEmail({ dedupeKey: `test:${user.id}:${Date.now()}`, kind: "test", to, subject, html, text });
  await recordAudit({ actor: user, action: "settings.test_email", target: { type: "settings", id: "email" }, summary: `Sent a test email to ${to}`, details: { to, result: r } });
  const notice = r !== "sent" ? "test-failed" : env().EMAIL_PROVIDER === "console" ? "test-console" : "test-sent";
  redirect(`/admin/settings?notice=${notice}`);
}

export async function runTickNowAction() {
  const user = await assertAdmin();
  await recordAudit({ actor: user, action: "system.process_queue", target: { type: "system" }, summary: "Started queue processing" });
  kickProcessing(55_000);
  redirect("/admin/system?notice=tick-started");
}

export async function retryJobAction(formData: FormData) {
  const user = await assertAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("jobId"));
  const retried = await db
    .update(jobs)
    .set({ status: "queued", attempts: 0, runAfter: new Date(), lastError: null, completedAt: null })
    .where(and(eq(jobs.id, id), eq(jobs.status, "failed")))
    .returning({ id: jobs.id, type: jobs.type });
  if (retried[0]) await recordAudit({ actor: user, action: "system.retry_job", target: { type: "job", id }, summary: `Retried failed ${retried[0].type} job #${id}` });
  kickProcessing();
  revalidatePath("/admin/system");
}

export async function sendNewsletterPreviewAction(formData: FormData) {
  const user = await assertAdmin();
  const to = parseEmailList(String(formData.get("to") ?? user.email)).valid[0] ?? user.email;
  const limit = await checkRateLimit({ key: `test-email:${user.id}`, limit: 5, windowSeconds: 3600 });
  if (!limit.allowed) redirect("/admin/settings?notice=rate-limited");
  const r = await sendNewsletterPreview(to, user.id);
  await recordAudit({ actor: user, action: "settings.newsletter_preview", target: { type: "settings", id: "email" }, summary: `Sent a newsletter preview to ${to}`, details: { to, result: r } });
  const notice = r !== "sent" ? "test-failed" : env().EMAIL_PROVIDER === "console" ? "test-console" : "preview-sent";
  redirect(`/admin/settings?notice=${notice}`);
}
