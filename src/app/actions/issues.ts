"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { assertDealershipAccess } from "@/lib/auth/tenant";
import { cleanText } from "@/lib/security/sanitize";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { getLatestScans } from "@/lib/queries/dealership";
import { isAssignableUser, resolveTargets, setIssueStates } from "@/lib/issues/states";
import { ISSUE_WORKFLOW_STATUSES, MAX_NOTE_LENGTH } from "@/lib/issues/workflow";

const schema = z.object({
  id: z.coerce.number().int().positive(),
  fingerprint: z
    .string()
    .regex(/^[0-9a-f]{16,64}$/)
    .optional(),
  checkKey: z
    .string()
    .regex(/^[a-z0-9_]{1,80}$/)
    .optional(),
  status: z.enum(ISSUE_WORKFLOW_STATUSES),
  note: z.string().max(MAX_NOTE_LENGTH * 2).optional(),
  assignedTo: z.string().optional(),
  back: z.string().max(500).optional(),
});

/**
 * Set the workflow status of one issue (by fingerprint) or of every finding of
 * one check, for one dealership. Admins only; viewers and dealership logins
 * see the status read-only.
 *
 * Targets are resolved from the dealership's own latest scan, so a fingerprint
 * or check key from the browser can never reach another dealership's issues.
 * This changes tracking only — the score is never recalculated from it.
 */
export async function updateIssueStateAction(formData: FormData) {
  const user = await assertAdmin();
  const parsed = schema.safeParse(Object.fromEntries(formData));
  if (!parsed.success) throw new Error("Invalid issue update.");
  const v = parsed.data;
  await assertDealershipAccess(v.id);
  const { latest } = await getLatestScans(v.id);
  const back = v.back && v.back.startsWith(`/dealerships/${v.id}`) ? v.back : `/dealerships/${v.id}?tab=issues`;
  if (!latest || (!v.fingerprint && !v.checkKey)) redirect(back);

  let assignedTo: number | null = null;
  if (v.assignedTo && v.assignedTo !== "") {
    const n = Number(v.assignedTo);
    if (Number.isInteger(n) && n > 0 && (await isAssignableUser(n))) assignedTo = n;
  }
  const note = v.note ? cleanText(v.note, MAX_NOTE_LENGTH) || null : null;
  const targets = await resolveTargets(v.id, latest.id, v.fingerprint ? { fingerprint: v.fingerprint } : { checkKey: v.checkKey });
  const n = await setIssueStates({ dealershipId: v.id, targets, status: v.status, note, assignedTo, by: user.id });
  await logger.info("admin", "Issue workflow updated", { by: user.email, status: v.status, issues: n, check: v.checkKey ?? null }, v.id);
  await recordAudit({ actor: user, action: "issue.status", target: { type: "dealership", id: v.id }, summary: `Set ${n} issue(s) to ${v.status}`, details: { status: v.status, issues: n, checkKey: v.checkKey ?? null, fingerprint: v.fingerprint ?? null, assignedTo } });
  revalidatePath(`/dealerships/${v.id}`);
  redirect(back);
}
