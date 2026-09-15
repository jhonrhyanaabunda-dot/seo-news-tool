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
import { saveSettings } from "@/lib/settings";

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
    })
    .safeParse(Object.fromEntries(formData));
  if (!input.success) return { error: "Please check the highlighted values: " + input.error.issues.map((i) => `${String(i.path[0])} ${i.message.toLowerCase()}`).join("; ") };
  await saveSettings({
    ...input.data,
    dailyDigestEnabled: bool(formData.get("dailyDigestEnabled")),
    weeklyDigestEnabled: bool(formData.get("weeklyDigestEnabled")),
    sendDigestWhenNoChanges: bool(formData.get("sendDigestWhenNoChanges")),
    instantAlertsEnabled: bool(formData.get("instantAlertsEnabled")),
    schedulerPaused: bool(formData.get("schedulerPaused")),
    managementRecipients: emails.valid,
    newsletterRecipients: newsletterEmails.valid,
  });
  await logger.info("admin", "Settings updated", { by: user.email });
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
  const notice = r !== "sent" ? "test-failed" : env().EMAIL_PROVIDER === "console" ? "test-console" : "test-sent";
  redirect(`/admin/settings?notice=${notice}`);
}

export async function runTickNowAction() {
  await assertAdmin();
  kickProcessing(55_000);
  redirect("/admin/system?notice=tick-started");
}

export async function retryJobAction(formData: FormData) {
  await assertAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("jobId"));
  await db
    .update(jobs)
    .set({ status: "queued", attempts: 0, runAfter: new Date(), lastError: null, completedAt: null })
    .where(and(eq(jobs.id, id), eq(jobs.status, "failed")));
  kickProcessing();
  revalidatePath("/admin/system");
}

export async function sendNewsletterPreviewAction(formData: FormData) {
  const user = await assertAdmin();
  const to = parseEmailList(String(formData.get("to") ?? user.email)).valid[0] ?? user.email;
  const limit = await checkRateLimit({ key: `test-email:${user.id}`, limit: 5, windowSeconds: 3600 });
  if (!limit.allowed) redirect("/admin/settings?notice=rate-limited");
  const r = await sendNewsletterPreview(to, user.id);
  const notice = r !== "sent" ? "test-failed" : env().EMAIL_PROVIDER === "console" ? "test-console" : "preview-sent";
  redirect(`/admin/settings?notice=${notice}`);
}
