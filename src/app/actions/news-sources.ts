"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { assertDealershipAccess } from "@/lib/auth/tenant";
import { getDealership } from "@/lib/queries/dealership";
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
  const id = idSchema.parse(formData.get("id"));
  const sourceId = idSchema.parse(formData.get("sourceId"));
  // Admin for the operation, dealership access for the target, and then the
  // source must belong to that dealership. The form supplies both ids, so
  // neither is allowed to vouch for the other.
  const user = await assertAdmin();
  await assertDealershipAccess(id);
  const dealership = await getDealership(id);
  if (!dealership) return;
  const removed = await removeNewsSource(sourceId, dealership);
  if (!removed) {
    await logger.warn("admin", "News source delete did not match the dealership", { by: user.email, sourceId }, id);
  }
  revalidatePath(`/admin/dealerships/${id}/edit`);
}
