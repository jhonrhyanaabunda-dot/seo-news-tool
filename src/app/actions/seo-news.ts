"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { enqueueJob } from "@/lib/jobs/queue";
import { kickProcessing } from "@/lib/jobs/kick";
import { logger } from "@/lib/logger";
import { addSeoFeed, removeSeoFeed, setSeoFeedEnabled } from "@/lib/news/seo-industry";

export type SeoFeedState = { error?: string; ok?: boolean } | undefined;

const idSchema = z.coerce.number().int().positive();

export async function addSeoFeedAction(_prev: SeoFeedState, formData: FormData): Promise<SeoFeedState> {
  const user = await assertAdmin();
  const url = String(formData.get("url") ?? "");
  const error = await addSeoFeed({ label: String(formData.get("label") ?? ""), url, official: formData.get("official") === "on" });
  if (error) return { error };
  await logger.info("admin", "SEO news feed added", { by: user.email, url });
  // Read the new feed right away instead of waiting for the next scheduled fetch.
  await enqueueJob({ type: "industry_news", dedupeKey: "industry-news", priority: 90, maxAttempts: 2 });
  kickProcessing();
  revalidatePath("/seo-news");
  return { ok: true };
}

export async function toggleSeoFeedAction(formData: FormData) {
  await assertAdmin();
  await setSeoFeedEnabled(idSchema.parse(formData.get("feedId")), formData.get("enabled") === "true");
  revalidatePath("/seo-news");
}

export async function removeSeoFeedAction(formData: FormData) {
  const user = await assertAdmin();
  const id = idSchema.parse(formData.get("feedId"));
  await removeSeoFeed(id);
  await logger.info("admin", "SEO news feed removed", { by: user.email, feedId: id });
  revalidatePath("/seo-news");
}

export async function fetchSeoNewsNowAction() {
  await assertAdmin();
  await enqueueJob({ type: "industry_news", dedupeKey: "industry-news", priority: 90, maxAttempts: 2 });
  kickProcessing();
  redirect("/seo-news?notice=fetching");
}
