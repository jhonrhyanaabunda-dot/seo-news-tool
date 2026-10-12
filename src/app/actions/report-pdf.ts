"use server";

import { z } from "zod";
import { assertDealershipAccess } from "@/lib/auth/tenant";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { getRenderStatus, requestReportPdf, type RenderStatus } from "@/lib/reports/request-pdf";

const idSchema = z.coerce.number().int().positive();

export type PdfState = { status?: RenderStatus; error?: string } | undefined;

/**
 * Ask for this dealership's report as a PDF.
 *
 * Authorisation is decided here, from the caller's session, before any render
 * key exists — the worker is trusted to print a page, never to decide who may
 * see it. The rate limit is the same shape as the other manual triggers, so a
 * held-down button cannot queue browser work indefinitely.
 */
export async function requestReportPdfAction(_prev: PdfState, formData: FormData): Promise<PdfState> {
  const id = idSchema.safeParse(formData.get("id"));
  if (!id.success) return { error: "That report is not available." };
  const user = await assertDealershipAccess(id.data);

  const limit = await checkRateLimit({ key: `report-pdf:${user.id}`, limit: 10, windowSeconds: 3600 });
  if (!limit.allowed) return { error: "You have requested several reports in the last hour. Please wait a little before trying again." };

  return { status: await requestReportPdf(id.data, user.id) };
}

/** Poll one render the caller already started. */
export async function reportPdfStatusAction(dealershipId: number, renderId: number): Promise<RenderStatus | null> {
  const d = idSchema.safeParse(dealershipId);
  const r = idSchema.safeParse(renderId);
  if (!d.success || !r.success) return null;
  await assertDealershipAccess(d.data);
  return getRenderStatus(r.data, d.data);
}
