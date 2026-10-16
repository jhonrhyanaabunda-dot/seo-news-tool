"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { enqueueJob } from "@/lib/jobs/queue";
import { kickProcessing } from "@/lib/jobs/kick";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { addSeoFeed, removeSeoFeed, setSeoFeedEnabled } from "@/lib/news/seo-industry";

export type SeoFeedState = { error?: string; ok?: boolean } | undefined;

const idSchema = z.coerce.number().int().positive();

export async function addSeoFeedAction(_prev: SeoFeedState, formData: FormData): Promise<SeoFeedState> {
  const user = await assertAdmin();
  const url = String(formData.get("url") ?? "");
  const error = await addSeoFeed({ label: String(formData.get("label") ?? ""), url, official: formData.get("official") === "on" });
  if (error) return { error };
  await logger.info("admin", "SEO news feed added", { by: user.email, url });
  await recordAudit({ actor: user, action: "seo_feed.add", target: { type: "seo_feed" }, summary: `Added SEO news feed ${url.slice(0, 300)}`, details: { url, label: String(formData.get("label") ?? "").slice(0, 200) } });
  // Read the new feed right away instead of waiting for the next scheduled fetch.
  await enqueueJob({ type: "industry_news", dedupeKey: "industry-news", priority: 90, maxAttempts: 2 });
  kickProcessing();
  revalidatePath("/seo-news");
  return { ok: true };
}

export async function toggleSeoFeedAction(formData: FormData) {
  const user = await assertAdmin();
  const feedId = idSchema.parse(formData.get("feedId"));
  const enabled = formData.get("enabled") === "true";
  await setSeoFeedEnabled(feedId, enabled);
  await recordAudit({ actor: user, action: "seo_feed.toggle", target: { type: "seo_feed", id: feedId }, summary: `${enabled ? "Turned on" : "Turned off"} SEO news feed #${feedId}`, details: { enabled } });
  revalidatePath("/seo-news");
}

export async function removeSeoFeedAction(formData: FormData) {
  const user = await assertAdmin();
  const id = idSchema.parse(formData.get("feedId"));
  await removeSeoFeed(id);
  await logger.info("admin", "SEO news feed removed", { by: user.email, feedId: id });
  await recordAudit({ actor: user, action: "seo_feed.remove", target: { type: "seo_feed", id }, summary: `Removed SEO news feed #${id}` });
  revalidatePath("/seo-news");
}

export async function fetchSeoNewsNowAction() {
  const user = await assertAdmin();
  await recordAudit({ actor: user, action: "seo_feed.fetch_now", target: { type: "seo_feed" }, summary: "Fetched SEO news now" });
  await enqueueJob({ type: "industry_news", dedupeKey: "industry-news", priority: 90, maxAttempts: 2 });
  kickProcessing();
  redirect("/seo-news?notice=fetching");
}
