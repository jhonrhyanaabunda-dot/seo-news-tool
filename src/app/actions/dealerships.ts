"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin, assertUser } from "@/lib/auth/guards";
import { addCustomKeyword, createDealership, deleteDealership, removeKeyword, updateDealership, validateDealershipForm, type DealershipFormErrors } from "@/lib/dealerships/service";
import { enqueueJob } from "@/lib/jobs/queue";
import { kickProcessing } from "@/lib/jobs/kick";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { cancelScan, createScanAndJob } from "@/lib/seo/scans";
import { getDealership } from "@/lib/queries/dealership";

export type DealershipFormState = { errors?: DealershipFormErrors; values?: Record<string, string> } | undefined;

const FORM_FIELDS = ["name", "websiteUrl", "brand", "dealerGroup", "city", "state", "websitePlatform", "sitemapUrl", "notificationEmails", "seoEnabled", "newsEnabled", "instantAlertsEnabled", "preferredRegion", "renderMode", "isActive", "maxPages", "scanIntervalHours", "notes"];
const submitted = (fd: FormData) => Object.fromEntries(FORM_FIELDS.map((k) => [k, String(fd.get(k) ?? "")]));

const idSchema = z.coerce.number().int().positive();

export async function createDealershipAction(_prev: DealershipFormState, formData: FormData): Promise<DealershipFormState> {
  const user = await assertAdmin();
  const v = await validateDealershipForm(formData);
  if (!v.ok) return { errors: v.errors, values: submitted(formData) };
  const d = await createDealership(v.data);
  await logger.info("admin", "Dealership created", { by: user.email, name: d.name }, d.id);
  kickProcessing(); // first scan starts right away (it is due immediately)
  revalidatePath("/");
  redirect(`/dealerships/${d.id}?created=1`);
}

export async function updateDealershipAction(_prev: DealershipFormState, formData: FormData): Promise<DealershipFormState> {
  const user = await assertAdmin();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { errors: { form: "Invalid dealership." } };
  const v = await validateDealershipForm(formData);
  if (!v.ok) return { errors: v.errors, values: submitted(formData) };
  const before = await getDealership(id.data);
  const d = await updateDealership(id.data, v.data);
  if (!d) return { errors: { form: "This dealership no longer exists." } };
  await logger.info("admin", "Dealership updated", { by: user.email }, d.id);
  // New website address → scan it right away so the report reflects the right site.
  if (before && before.host !== d.host && d.seoEnabled && d.isActive) {
    await createScanAndJob(d.id, "manual");
    kickProcessing();
    revalidatePath("/");
    redirect(`/dealerships/${d.id}?updated=1&notice=site-changed`);
  }
  revalidatePath("/");
  revalidatePath(`/dealerships/${d.id}`);
  redirect(`/dealerships/${d.id}?updated=1`);
}

export async function deleteDealershipAction(formData: FormData) {
  const user = await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  await deleteDealership(id);
  await logger.warn("admin", "Dealership deleted", { by: user.email, dealershipId: id });
  revalidatePath("/");
  redirect("/admin/dealerships?deleted=1");
}

export async function scanNowAction(formData: FormData) {
  const user = await assertUser();
  const id = idSchema.parse(formData.get("id"));
  const limit = await checkRateLimit({ key: `scan-now:${user.id}`, limit: 20, windowSeconds: 3600 });
  if (!limit.allowed) redirect(`/dealerships/${id}?notice=rate-limited`);
  const scanId = await createScanAndJob(id, "manual");
  if (scanId) kickProcessing();
  revalidatePath(`/dealerships/${id}`);
  redirect(`/dealerships/${id}?notice=${scanId ? "scan-queued" : "scan-running"}`);
}

export async function newsScanNowAction(formData: FormData) {
  const user = await assertUser();
  const id = idSchema.parse(formData.get("id"));
  const limit = await checkRateLimit({ key: `news-now:${user.id}`, limit: 20, windowSeconds: 3600 });
  if (!limit.allowed) redirect(`/dealerships/${id}?tab=news&notice=rate-limited`);
  await enqueueJob({ type: "news_scan", dealershipId: id, dedupeKey: `news:${id}`, priority: 20 });
  kickProcessing();
  redirect(`/dealerships/${id}?tab=news&notice=news-queued`);
}

export async function cancelScanAction(formData: FormData) {
  await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  const scanId = idSchema.parse(formData.get("scanId"));
  await cancelScan(scanId);
  revalidatePath(`/dealerships/${id}`);
  redirect(`/dealerships/${id}?notice=scan-cancelled`);
}

export type KeywordState = { error?: string; ok?: boolean } | undefined;

export async function addKeywordAction(_prev: KeywordState, formData: FormData): Promise<KeywordState> {
  await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  const error = await addCustomKeyword(id, String(formData.get("keyword") ?? ""));
  if (error) return { error };
  revalidatePath(`/admin/dealerships/${id}/edit`);
  return { ok: true };
}

export async function removeKeywordAction(formData: FormData) {
  await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  const keywordId = idSchema.parse(formData.get("keywordId"));
  await removeKeyword(id, keywordId);
  revalidatePath(`/admin/dealerships/${id}/edit`);
}
