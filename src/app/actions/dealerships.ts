"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { assertDealershipAccess } from "@/lib/auth/tenant";
import { addCustomKeyword, createDealership, deleteDealership, removeKeyword, updateDealership, validateDealershipForm, type DealershipFormErrors } from "@/lib/dealerships/service";
import { enqueueJob } from "@/lib/jobs/queue";
import { kickProcessing } from "@/lib/jobs/kick";
import { logger } from "@/lib/logger";
import { changedKeys, recordAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { cancelScan, createScanAndJob } from "@/lib/seo/scans";
import { getDealership } from "@/lib/queries/dealership";
import { INTEGRATION_FORM_FIELDS } from "@/lib/integrations/form";

export type DealershipFormState = { errors?: DealershipFormErrors; values?: Record<string, string> } | undefined;

const FORM_FIELDS = ["name", "websiteUrl", "brand", "dealerGroup", "city", "state", "websitePlatform", "sitemapUrl", "notificationEmails", "seoEnabled", "newsEnabled", "instantAlertsEnabled", "preferredRegion", "renderMode", "isActive", "maxPages", "scanIntervalHours", "notes", ...INTEGRATION_FORM_FIELDS];
const submitted = (fd: FormData) => Object.fromEntries(FORM_FIELDS.map((k) => [k, String(fd.get(k) ?? "")]));

const idSchema = z.coerce.number().int().positive();

export async function createDealershipAction(_prev: DealershipFormState, formData: FormData): Promise<DealershipFormState> {
  const user = await assertAdmin();
  const v = await validateDealershipForm(formData);
  if (!v.ok) return { errors: v.errors, values: submitted(formData) };
  const d = await createDealership(v.data);
  await logger.info("admin", "Dealership created", { by: user.email, name: d.name }, d.id);
  await recordAudit({ actor: user, action: "dealership.create", target: { type: "dealership", id: d.id }, summary: `Created ${d.name}`, details: { name: d.name, websiteUrl: d.websiteUrl } });
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
  await recordAudit({
    actor: user,
    action: "dealership.update",
    target: { type: "dealership", id: d.id },
    summary: `Edited ${d.name}`,
    details: { changed: before ? changedKeys(before as unknown as Record<string, unknown>, d as unknown as Record<string, unknown>).filter((k) => k !== "updatedAt") : [] },
  });
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
  const existing = await getDealership(id);
  await deleteDealership(id);
  await logger.warn("admin", "Dealership deleted", { by: user.email, dealershipId: id });
  await recordAudit({ actor: user, action: "dealership.delete", target: { type: "dealership", id }, summary: `Deleted ${existing?.name ?? `dealership #${id}`}`, details: existing ? { name: existing.name, websiteUrl: existing.websiteUrl } : undefined });
  revalidatePath("/");
  redirect("/admin/dealerships?deleted=1");
}

export async function scanNowAction(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  const user = await assertDealershipAccess(id);
  const limit = await checkRateLimit({ key: `scan-now:${user.id}`, limit: 20, windowSeconds: 3600 });
  if (!limit.allowed) redirect(`/dealerships/${id}?notice=rate-limited`);
  const scanId = await createScanAndJob(id, "manual");
  await logger.info("admin", scanId ? "Manual scan queued" : "Manual scan requested while one is running", { by: user.email, scanId }, id);
  await recordAudit({ actor: user, action: "dealership.scan_now", target: { type: "dealership", id }, summary: scanId ? "Started an SEO scan" : "Asked for a scan while one was running", details: { scanId } });
  if (scanId) kickProcessing();
  revalidatePath(`/dealerships/${id}`);
  redirect(`/dealerships/${id}?notice=${scanId ? "scan-queued" : "scan-running"}`);
}

export async function newsScanNowAction(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  const user = await assertDealershipAccess(id);
  const limit = await checkRateLimit({ key: `news-now:${user.id}`, limit: 20, windowSeconds: 3600 });
  if (!limit.allowed) redirect(`/dealerships/${id}?tab=news&notice=rate-limited`);
  await enqueueJob({ type: "news_scan", dealershipId: id, dedupeKey: `news:${id}`, priority: 20 });
  await logger.info("admin", "Manual news check queued", { by: user.email }, id);
  await recordAudit({ actor: user, action: "dealership.news_scan_now", target: { type: "dealership", id }, summary: "Started a news check" });
  kickProcessing();
  redirect(`/dealerships/${id}?tab=news&notice=news-queued`);
}

export async function cancelScanAction(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  const scanId = idSchema.parse(formData.get("scanId"));
  // Admin for the operation, dealership access for the target, and the scan
  // itself must belong to that dealership — the form supplies both ids, so
  // neither one may vouch for the other.
  await assertAdmin();
  const user = await assertDealershipAccess(id);
  const cancelled = await cancelScan(scanId, id);
  if (cancelled) {
    await logger.info("admin", "Scan cancelled", { by: user.email, scanId }, id);
    await recordAudit({ actor: user, action: "dealership.scan_cancel", target: { type: "dealership", id }, summary: `Cancelled scan #${scanId}`, details: { scanId } });
  }
  revalidatePath(`/dealerships/${id}`);
  redirect(`/dealerships/${id}?notice=${cancelled ? "scan-cancelled" : "scan-not-cancellable"}`);
}

export type KeywordState = { error?: string; ok?: boolean } | undefined;

export async function addKeywordAction(_prev: KeywordState, formData: FormData): Promise<KeywordState> {
  const user = await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  const keyword = String(formData.get("keyword") ?? "");
  const error = await addCustomKeyword(id, keyword);
  if (error) return { error };
  await recordAudit({ actor: user, action: "keyword.add", target: { type: "dealership", id }, summary: `Added keyword “${keyword.trim().slice(0, 200)}”`, details: { keyword: keyword.trim().slice(0, 200) } });
  revalidatePath(`/admin/dealerships/${id}/edit`);
  return { ok: true };
}

export async function removeKeywordAction(formData: FormData) {
  const user = await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  const keywordId = idSchema.parse(formData.get("keywordId"));
  await removeKeyword(id, keywordId);
  await recordAudit({ actor: user, action: "keyword.remove", target: { type: "dealership", id }, summary: `Removed keyword #${keywordId}`, details: { keywordId } });
  revalidatePath(`/admin/dealerships/${id}/edit`);
}
