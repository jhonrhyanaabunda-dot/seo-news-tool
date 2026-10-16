"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { recordAudit } from "@/lib/audit";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { checkRateLimit, clientIp } from "@/lib/security/rate-limit";
import { MFA_ENROLL_PATH } from "./guards";
import { adminMfaRequired, clearPendingMfa, consumeRecoveryCode, isMfaEnabled, pendingMatchesUser, readPendingMfa, setPendingMfa, verifyUserTotp } from "./mfa";
import { looksLikeRecoveryCode, mustEnrollMfa } from "./mfa-crypto";
import { verifyPassword } from "./password";
import { safeNextPath } from "./safe-next";
import { createSession, destroySession, getCurrentUser } from "./session";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
  next: z.string().optional(),
});

export type LoginState = { error?: string; email?: string } | undefined;

/**
 * Step one: email and password.
 *
 * With two-factor on, a correct password does not create a session. It issues
 * a five-minute signed pending cookie and moves to /login/verify; only a valid
 * code there creates the session. Everything that could reveal whether the
 * password was right (wording, timing) is identical either way until then.
 */
export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const parsed = loginSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });
  const typedEmail = String(formData.get("email") ?? "").slice(0, 320);
  if (!parsed.success) return { error: "Please enter a valid email address and password.", email: typedEmail };

  const h = await headers();
  const ip = clientIp(h);
  const { email, password } = parsed.data;

  const [ipLimit, emailLimit] = await Promise.all([
    checkRateLimit({ key: `login:ip:${ip}`, limit: 20, windowSeconds: 900 }),
    checkRateLimit({ key: `login:email:${email}`, limit: 8, windowSeconds: 900 }),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) {
    await logger.warn("auth", "Login rate limit hit", { ip, email });
    return { error: "Too many sign-in attempts. Please wait 15 minutes and try again.", email: typedEmail };
  }

  const [user] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);

  // Always run a compare to keep timing similar for unknown users.
  const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyPassword(password, "$2a$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalid");
  if (!user || !ok || !user.isActive) {
    await recordAudit({
      actor: user ? { id: user.id, email: user.email } : null,
      actorEmail: email,
      action: "auth.sign_in_failed",
      target: user ? { type: "user", id: user.id } : undefined,
      summary: !user ? "Sign-in for an unknown address" : !user.isActive ? "Sign-in to a deactivated account" : "Wrong password",
    });
    return { error: "Incorrect email or password.", email: typedEmail };
  }

  const remember = formData.get("remember") === "on";
  const next = safeNextPath(parsed.data.next);

  if (isMfaEnabled(user)) {
    await setPendingMfa(user, { remember, next });
    redirect("/login/verify");
  }

  await createSession(user.id, { userAgent: h.get("user-agent"), ip, remember });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await recordAudit({ actor: user, action: "auth.sign_in", target: { type: "user", id: user.id }, summary: "Signed in with password", details: { mfa: false, remember } });

  // An admin who must use two-factor but has not set it up goes straight to enrolment.
  if (mustEnrollMfa({ role: user.role, mfaEnabled: false }, await adminMfaRequired())) redirect(MFA_ENROLL_PATH);
  redirect(next);
}

export type MfaLoginState = { error?: string } | undefined;

/**
 * Step two: a code from the authenticator app, or one recovery code.
 *
 * The pending cookie names the account; it is HMAC-signed, expires after five
 * minutes and is bound to the password hash, so a password reset in between
 * voids it. Attempts are rate-limited per account and per address, the same
 * Postgres-backed limiter as the password step.
 */
export async function verifyMfaAction(_prev: MfaLoginState, formData: FormData): Promise<MfaLoginState> {
  const pending = await readPendingMfa();
  if (!pending) redirect("/login?expired=1");

  const code = String(formData.get("code") ?? "").slice(0, 64);
  if (!code.trim()) return { error: "Enter the 6-digit code from your authenticator app." };

  const h = await headers();
  const ip = clientIp(h);
  const [userLimit, ipLimit] = await Promise.all([
    checkRateLimit({ key: `mfa:user:${pending.uid}`, limit: 6, windowSeconds: 300 }),
    checkRateLimit({ key: `mfa:ip:${ip}`, limit: 30, windowSeconds: 900 }),
  ]);
  if (!userLimit.allowed || !ipLimit.allowed) {
    await logger.warn("auth", "Two-factor rate limit hit", { ip, userId: pending.uid });
    return { error: "Too many codes tried. Please wait a few minutes and try again." };
  }

  const [user] = await db.select().from(users).where(eq(users.id, pending.uid)).limit(1);
  if (!user || !pendingMatchesUser(pending, user) || !isMfaEnabled(user)) {
    await clearPendingMfa();
    redirect("/login?expired=1");
  }

  const recovery = looksLikeRecoveryCode(code);
  const ok = recovery ? await consumeRecoveryCode(user, code) : await verifyUserTotp(user, code);
  if (!ok) {
    await recordAudit({ actor: user, action: "auth.mfa_failed", target: { type: "user", id: user.id }, summary: recovery ? "Recovery code rejected" : "Authenticator code rejected" });
    return { error: recovery ? "That recovery code is not valid or has already been used." : "That code is not valid. Check the time on your phone and try the newest code." };
  }

  await clearPendingMfa();
  await createSession(user.id, { userAgent: h.get("user-agent"), ip, remember: pending.remember });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  if (recovery) {
    const left = Math.max(0, user.totpRecoveryHashes.length - 1);
    await recordAudit({ actor: user, action: "auth.recovery_code_used", target: { type: "user", id: user.id }, summary: `Signed in with a recovery code (${left} left)`, details: { remaining: left, remember: pending.remember } });
    await logger.warn("auth", "Recovery code used to sign in", { userId: user.id, remaining: left });
  } else {
    await recordAudit({ actor: user, action: "auth.sign_in", target: { type: "user", id: user.id }, summary: "Signed in with password and two-factor code", details: { mfa: true, remember: pending.remember } });
  }
  redirect(safeNextPath(pending.next));
}

/** "Use a different account": forget the half-finished sign-in. */
export async function cancelMfaAction() {
  await clearPendingMfa();
  redirect("/login");
}

export async function logoutAction() {
  const user = await getCurrentUser();
  if (user) await recordAudit({ actor: user, action: "auth.sign_out", target: { type: "user", id: user.id }, summary: "Signed out" });
  await destroySession();
  redirect("/login");
}
