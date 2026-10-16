"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { assertDealershipAccess } from "@/lib/auth/tenant";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { cleanText } from "@/lib/security/sanitize";
import { logger, errorMessage } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { kickProcessing } from "@/lib/jobs/kick";
import { placesConfigured } from "@/lib/integrations/config";
import { addCompetitor, removeCompetitor } from "@/lib/integrations/competitors";
import { placesClient, requestCompetitorAudit, requestIntegrationSync } from "@/lib/integrations/sync";
import type { PlaceCandidate } from "@/lib/integrations/places";

const idSchema = z.coerce.number().int().positive();

export type FindPlaceResult = { candidates: PlaceCandidate[]; error?: undefined } | { candidates?: undefined; error: string };

/**
 * "Find place" on the dealership form: a Places Text Search by name and city.
 * Admin only and rate-limited, because every search is a billed API request.
 */
export async function findPlaceAction(query: string): Promise<FindPlaceResult> {
  const user = await assertAdmin();
  const q = cleanText(query, 200);
  if (q.length < 3) return { error: "Enter the dealership name (and city) to search for." };
  if (!placesConfigured()) return { error: "Google Places is not connected. Set GOOGLE_PLACES_API_KEY (see README)." };
  const limit = await checkRateLimit({ key: `places-search:${user.id}`, limit: 30, windowSeconds: 3600 });
  if (!limit.allowed) return { error: `Too many searches. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.` };
  try {
    const candidates = await placesClient()!.search(q);
    return candidates.length ? { candidates } : { error: "Google found no matching business. Try the name as it appears on Google Maps." };
  } catch (err) {
    await logger.warn("integrations", "Place search failed", { error: errorMessage(err) });
    return { error: errorMessage(err) };
  }
}

export type CompetitorFormState = { errors?: { name?: string; websiteUrl?: string; form?: string }; ok?: boolean } | undefined;

export async function addCompetitorAction(_prev: CompetitorFormState, formData: FormData): Promise<CompetitorFormState> {
  const user = await assertAdmin();
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { errors: { form: "Invalid dealership." } };
  const r = await addCompetitor(id.data, { name: formData.get("name"), websiteUrl: formData.get("websiteUrl") });
  if (!r.ok) return { errors: { [r.field]: r.error } };
  await logger.info("admin", "Competitor added", { by: user.email, host: r.competitor.host }, id.data);
  await recordAudit({ actor: user, action: "competitor.add", target: { type: "dealership", id: id.data }, summary: `Added competitor ${r.competitor.host}`, details: { competitorId: r.competitor.id, host: r.competitor.host } });
  await requestCompetitorAudit(id.data, r.competitor.id);
  kickProcessing();
  revalidatePath(`/admin/dealerships/${id.data}/edit`);
  revalidatePath(`/dealerships/${id.data}`);
  return { ok: true };
}

export async function removeCompetitorAction(formData: FormData) {
  const user = await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  const competitorId = idSchema.parse(formData.get("competitorId"));
  // Scoped by dealership: the form supplies both ids, so neither vouches for the other.
  if (await removeCompetitor(id, competitorId)) {
    await logger.info("admin", "Competitor removed", { by: user.email, competitorId }, id);
    await recordAudit({ actor: user, action: "competitor.remove", target: { type: "dealership", id }, summary: `Removed competitor #${competitorId}`, details: { competitorId } });
  }
  revalidatePath(`/admin/dealerships/${id}/edit`);
  revalidatePath(`/dealerships/${id}`);
}

/** Admin "Sync now" on the Search performance tab. */
export async function syncIntegrationsNowAction(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  await assertAdmin();
  const user = await assertDealershipAccess(id);
  const limit = await checkRateLimit({ key: `integrations-sync:${user.id}`, limit: 10, windowSeconds: 3600 });
  if (!limit.allowed) redirect(`/dealerships/${id}?tab=search&sync=rate-limited`);
  const queued = await requestIntegrationSync(id);
  await logger.info("admin", "Data integration sync requested", { by: user.email, queued }, id);
  await recordAudit({ actor: user, action: "integrations.sync_now", target: { type: "dealership", id }, summary: queued ? "Queued a Search Console / Google listing sync" : "Sync requested; nothing to sync", details: { queued } });
  if (queued) kickProcessing();
  redirect(`/dealerships/${id}?tab=search&sync=${queued ? "queued" : "nothing"}`);
}
