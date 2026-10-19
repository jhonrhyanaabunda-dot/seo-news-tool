"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { checkRateLimit, clientIp } from "@/lib/security/rate-limit";
import { verifyPassword } from "./password";
import { safeNextPath } from "./safe-next";
import { createSession, destroySession, getCurrentUser } from "./session";
import { env } from "@/lib/env";
import { recordAudit } from "@/lib/audit";
import { SECOND_FACTOR_COOKIE, SECOND_FACTOR_TTL_MS, consumeRecoveryCode, decryptTotpSecret, readTicket, signTicket, verifyTotp } from "./totp";

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  password: z.string().min(1).max(200),
  next: z.string().optional(),
});

export type LoginState = { error?: string; email?: string } | undefined;

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
    await recordAudit({ actor: user ? { id: user.id, email: user.email } : null, action: "auth.sign_in_failed", target: { type: "user", id: user?.id }, summary: `Sign-in failed for ${email}`, details: { email, reason: !user ? "unknown_email" : !ok ? "wrong_password" : "inactive" } });
    return { error: "Incorrect email or password.", email: typedEmail };
  }

  const remember = formData.get("remember") === "on";
  // Two-factor accounts get no session yet: a short-lived signed ticket, redeemed on /login/verify.
  if (user.totpEnabledAt && user.totpSecretEnc) {
    const ticket = signTicket({ uid: user.id, remember, next: safeNextPath(parsed.data.next), exp: Date.now() + SECOND_FACTOR_TTL_MS }, env().AUTH_SECRET);
    (await cookies()).set(SECOND_FACTOR_COOKIE, ticket, { httpOnly: true, sameSite: "lax", secure: env().NODE_ENV === "production", path: "/", maxAge: SECOND_FACTOR_TTL_MS / 1000 });
    redirect("/login/verify");
  }

  await createSession(user.id, { userAgent: h.get("user-agent"), ip, remember });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await recordAudit({ actor: { id: user.id, email: user.email }, action: "auth.sign_in", target: { type: "user", id: user.id }, summary: "Signed in" });

  redirect(safeNextPath(parsed.data.next));
}

export type VerifyState = { error?: string } | undefined;

/** Second sign-in step: a 6-digit authenticator code, or one of the recovery codes. */
export async function verifySecondFactorAction(_prev: VerifyState, formData: FormData): Promise<VerifyState> {
  const jar = await cookies();
  const ticket = readTicket(jar.get(SECOND_FACTOR_COOKIE)?.value, env().AUTH_SECRET);
  if (!ticket) return { error: "This sign-in has expired. Please enter your email and password again." };
  const h = await headers();
  const ip = clientIp(h);
  const [userLimit, ipLimit] = await Promise.all([
    checkRateLimit({ key: `2fa:user:${ticket.uid}`, limit: 6, windowSeconds: 900 }),
    checkRateLimit({ key: `2fa:ip:${ip}`, limit: 30, windowSeconds: 900 }),
  ]);
  if (!userLimit.allowed || !ipLimit.allowed) {
    await logger.warn("auth", "Two-factor rate limit hit", { ip, userId: ticket.uid });
    return { error: "Too many attempts. Please wait 15 minutes and try again." };
  }

  const code = String(formData.get("code") ?? "").trim().slice(0, 40);
  const [user] = await db.select().from(users).where(eq(users.id, ticket.uid)).limit(1);
  if (!user || !user.isActive || !user.totpEnabledAt || !user.totpSecretEnc) return { error: "This sign-in has expired. Please enter your email and password again." };

  const secret = decryptTotpSecret(user.totpSecretEnc, env().AUTH_SECRET);
  const step = verifyTotp(secret, code, user.totpLastStep ?? null);
  if (step !== null) {
    await db.update(users).set({ totpLastStep: step, lastLoginAt: new Date() }).where(eq(users.id, user.id));
  } else {
    const left = consumeRecoveryCode(code, user.totpRecoveryHashes ?? [], env().AUTH_SECRET);
    if (!left) {
      await logger.warn("auth", "Two-factor code rejected", { ip, userId: user.id });
      await recordAudit({ actor: { id: user.id, email: user.email }, action: "auth.mfa_failed", target: { type: "user", id: user.id }, summary: "Two-factor code rejected" });
      return { error: "That code is not right. Check the app and try the current code." };
    }
    await db.update(users).set({ totpRecoveryHashes: left, lastLoginAt: new Date() }).where(eq(users.id, user.id));
    await logger.warn("auth", "Signed in with a recovery code", { userId: user.id, recoveryCodesLeft: left.length });
    await recordAudit({ actor: { id: user.id, email: user.email }, action: "auth.recovery_code_used", target: { type: "user", id: user.id }, summary: "Signed in with a recovery code", details: { recoveryCodesLeft: left.length } });
  }

  jar.delete(SECOND_FACTOR_COOKIE);
  await createSession(user.id, { userAgent: h.get("user-agent"), ip, remember: ticket.remember });
  await recordAudit({ actor: { id: user.id, email: user.email }, action: "auth.sign_in", target: { type: "user", id: user.id }, summary: "Signed in with two-factor" });
  redirect(safeNextPath(ticket.next));
}

export async function logoutAction() {
  const user = await getCurrentUser();
  if (user) await recordAudit({ actor: user, action: "auth.sign_out", target: { type: "user", id: user.id }, summary: "Signed out" });
  await destroySession();
  redirect("/login");
}
