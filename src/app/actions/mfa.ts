"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { recordAudit } from "@/lib/audit";
import { assertUser } from "@/lib/auth/guards";
import { beginEnrollment, cancelEnrollment, clearMfa, confirmEnrollment, isMfaEnabled, regenerateRecoveryCodes, verifyUserTotp } from "@/lib/auth/mfa";
import { verifyPassword } from "@/lib/auth/password";
import { normalizeTotpCode } from "@/lib/auth/totp";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/security/rate-limit";

/**
 * Two-factor management for the signed-in user's own account. Every check is
 * against the session's user id; nothing here takes a user id from the form.
 */

export type MfaFormState = { error?: string; ok?: string; recoveryCodes?: string[] } | undefined;

const TOO_MANY = "Too many attempts. Please wait a few minutes and try again.";

async function limited(userId: number): Promise<boolean> {
  const r = await checkRateLimit({ key: `mfa-manage:${userId}`, limit: 10, windowSeconds: 900 });
  return !r.allowed;
}

export async function beginMfaEnrollmentAction() {
  const me = await assertUser();
  await beginEnrollment(me.id);
  revalidatePath("/account");
  redirect("/account#two-factor");
}

export async function cancelMfaEnrollmentAction() {
  const me = await assertUser();
  await cancelEnrollment(me.id);
  revalidatePath("/account");
  redirect("/account#two-factor");
}

/**
 * Confirm with a first code. The page is deliberately not revalidated here:
 * the recovery codes live only in this response, and a refresh would replace
 * the form showing them. The client refreshes once they are saved.
 */
export async function confirmMfaEnrollmentAction(_prev: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const me = await assertUser();
  if (await limited(me.id)) return { error: TOO_MANY };
  const codes = await confirmEnrollment(me.id, String(formData.get("code") ?? "").slice(0, 20));
  if (!codes) return { error: "That code did not match. Make sure the app shows “A3 SEO Monitor” and enter the newest code." };
  await recordAudit({ actor: me, action: "mfa.enabled", target: { type: "user", id: me.id }, summary: "Turned on two-factor sign-in" });
  return { ok: "Two-factor sign-in is on.", recoveryCodes: codes };
}

/**
 * Turning two-factor off needs proof the person at the keyboard is the owner:
 * a current code, or the account password. A six-digit value is always read as
 * a code — a valid password is at least ten characters with letters.
 */
export async function disableMfaAction(_prev: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const me = await assertUser();
  if (await limited(me.id)) return { error: TOO_MANY };
  const credential = String(formData.get("credential") ?? "").slice(0, 200);
  const [u] = await db.select().from(users).where(eq(users.id, me.id)).limit(1);
  if (!u || !isMfaEnabled(u)) return { error: "Two-factor sign-in is not on for this account." };
  const isCode = /^\d{6}$/.test(normalizeTotpCode(credential));
  const ok = isCode ? await verifyUserTotp(u, credential) : await verifyPassword(credential, u.passwordHash);
  if (!ok) return { error: isCode ? "That code is not valid." : "That password is not correct." };
  await clearMfa(me.id);
  await recordAudit({ actor: me, action: "mfa.disabled", target: { type: "user", id: me.id }, summary: "Turned off two-factor sign-in", details: { confirmedWith: isCode ? "authenticator" : "password" } });
  revalidatePath("/account");
  revalidatePath("/", "layout");
  return { ok: "Two-factor sign-in is off." };
}

/** New recovery codes, confirmed with a current authenticator code. Not revalidated, for the same reason as confirm. */
export async function regenerateRecoveryCodesAction(_prev: MfaFormState, formData: FormData): Promise<MfaFormState> {
  const me = await assertUser();
  if (await limited(me.id)) return { error: TOO_MANY };
  const [u] = await db.select().from(users).where(eq(users.id, me.id)).limit(1);
  if (!u || !isMfaEnabled(u)) return { error: "Two-factor sign-in is not on for this account." };
  if (!(await verifyUserTotp(u, String(formData.get("code") ?? "").slice(0, 20)))) return { error: "That code is not valid." };
  const codes = await regenerateRecoveryCodes(me.id);
  if (!codes) return { error: "Two-factor sign-in is not on for this account." };
  await recordAudit({ actor: me, action: "mfa.recovery_regenerated", target: { type: "user", id: me.id }, summary: "Generated new recovery codes" });
  return { ok: "New recovery codes generated. The old ones no longer work.", recoveryCodes: codes };
}
