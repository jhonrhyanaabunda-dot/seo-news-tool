"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { logger } from "@/lib/logger";
import { addNewsSource, removeNewsSource } from "@/lib/news/sources";

export type NewsSourceState = { error?: string; ok?: boolean } | undefined;

const idSchema = z.coerce.number().int().positive();

export async function addNewsSourceAction(_prev: NewsSourceState, formData: FormData): Promise<NewsSourceState> {
  const user = await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  const error = await addNewsSource({
    dealershipId: id,
    sourceType: String(formData.get("sourceType") ?? ""),
    label: String(formData.get("label") ?? ""),
    url: String(formData.get("url") ?? ""),
    allBrandDealerships: formData.get("allBrandDealerships") === "on",
  });
  if (error) return { error };
  await logger.info("admin", "News source added", { by: user.email, url: String(formData.get("url") ?? "") }, id);
  revalidatePath(`/admin/dealerships/${id}/edit`);
  return { ok: true };
}

export async function removeNewsSourceAction(formData: FormData) {
  await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  const sourceId = idSchema.parse(formData.get("sourceId"));
  await removeNewsSource(sourceId);
  revalidatePath(`/admin/dealerships/${id}/edit`);
}
