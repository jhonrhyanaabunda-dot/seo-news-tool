"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { assertAdmin, assertUser } from "@/lib/auth/guards";
import { verifyPassword } from "@/lib/auth/password";
import {
  TOTP_SETUP_COOKIE, consumeRecoveryCode, decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, generateTotpSecret, hashRecoveryCode, verifyTotp,
} from "@/lib/auth/totp";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security/rate-limit";

export type TwoFactorState = { error?: string; ok?: string; codes?: string[] } | undefined;

const SETUP_TTL_SECONDS = 10 * 60;
const key = () => env().AUTH_SECRET;

async function loadUser(id: number) {
  const [u] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  return u ?? null;
}

/** Codes from the app or, where allowed, a recovery code. Returns what to store, or an error. */
async function checkCode(user: NonNullable<Awaited<ReturnType<typeof loadUser>>>, code: string, allowRecovery: boolean) {
  const limit = await checkRateLimit({ key: `2fa-manage:${user.id}`, limit: 10, windowSeconds: 900 });
  if (!limit.allowed) return { error: "Too many attempts. Please wait 15 minutes and try again." } as const;
  if (!user.totpSecretEnc) return { error: "Two-factor login is not set up." } as const;
  const step = verifyTotp(decryptTotpSecret(user.totpSecretEnc, key()), code, user.totpLastStep ?? null);
  if (step !== null) return { step } as const;
  if (allowRecovery) {
    const left = consumeRecoveryCode(code, user.totpRecoveryHashes ?? [], key());
    if (left) return { recoveryLeft: left } as const;
  }
  return { error: "That code is not right. Use the current code from your authenticator app." } as const;
}

/** Step 1: a new secret, kept encrypted in a short-lived cookie until a code from the app confirms it. */
export async function startTwoFactorSetupAction() {
  const me = await assertUser();
  const user = await loadUser(me.id);
  if (user?.totpEnabledAt) redirect("/account#two-factor");
  (await cookies()).set(TOTP_SETUP_COOKIE, encryptTotpSecret(generateTotpSecret(), key()), {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/account",
    maxAge: SETUP_TTL_SECONDS,
  });
  redirect("/account#two-factor");
}

export async function cancelTwoFactorSetupAction() {
  await assertUser();
  (await cookies()).delete({ name: TOTP_SETUP_COOKIE, path: "/account" });
  redirect("/account#two-factor");
}

/** Step 2: the first code proves the app holds the secret; then it is saved and recovery codes are issued once. */
export async function confirmTwoFactorAction(_prev: TwoFactorState, formData: FormData): Promise<TwoFactorState> {
  const me = await assertUser();
  const jar = await cookies();
  const pending = jar.get(TOTP_SETUP_COOKIE)?.value;
  if (!pending) return { error: "Setup took longer than 10 minutes. Start again." };
  const limit = await checkRateLimit({ key: `2fa-manage:${me.id}`, limit: 10, windowSeconds: 900 });
  if (!limit.allowed) return { error: "Too many attempts. Please wait 15 minutes and try again." };
  let secret: string;
  try {
    secret = decryptTotpSecret(pending, key());
  } catch {
    return { error: "Setup could not be read. Start again." };
  }
  const step = verifyTotp(secret, String(formData.get("code") ?? ""), null);
  if (step === null) return { error: "That code is not right. Check that the app shows A3 SEO Monitor and enter its current code." };

  const codes = generateRecoveryCodes();
  await db
    .update(users)
    .set({ totpSecretEnc: encryptTotpSecret(secret, key()), totpEnabledAt: new Date(), totpLastStep: step, totpRecoveryHashes: codes.map((c) => hashRecoveryCode(c, key())), updatedAt: new Date() })
    .where(eq(users.id, me.id));
  // The setup cookie is left to expire (10 minutes): changing a cookie in a server action re-renders the
  // page, which would also hide the recovery codes. Once 2FA is on the page ignores it.
  await logger.warn("auth", "Two-factor login turned on", { by: me.email, userId: me.id });
  // No revalidatePath here: refreshing /account would swap the setup form (which holds the
  // one-time recovery codes in its state) for the "On" view before the user could save them.
  return { ok: "Two-factor login is on.", codes };
}

const disableSchema = z.object({ password: z.string().min(1).max(200), code: z.string().min(1).max(40) });

/** Turning it off needs both the password and a current code (or a recovery code). */
export async function disableTwoFactorAction(_prev: TwoFactorState, formData: FormData): Promise<TwoFactorState> {
  const me = await assertUser();
  const parsed = disableSchema.safeParse({ password: formData.get("password"), code: formData.get("code") });
  if (!parsed.success) return { error: "Enter your password and a code." };
  const user = await loadUser(me.id);
  if (!user) return { error: "Account not found." };
  if (!(await verifyPassword(parsed.data.password, user.passwordHash))) return { error: "That password is not right." };
  const r = await checkCode(user, parsed.data.code, true);
  if ("error" in r) return { error: r.error };
  await db.update(users).set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: null, updatedAt: new Date() }).where(eq(users.id, me.id));
  // The setup cookie from turning it on may still be alive; without this the page would offer that old QR code.
  (await cookies()).delete({ name: TOTP_SETUP_COOKIE, path: "/account" });
  await logger.warn("auth", "Two-factor login turned off", { by: me.email, userId: me.id });
  revalidatePath("/account");
  return { ok: "Two-factor login is off." };
}

/** New recovery codes replace all the old ones; needs a current app code. */
export async function regenerateRecoveryCodesAction(_prev: TwoFactorState, formData: FormData): Promise<TwoFactorState> {
  const me = await assertUser();
  const user = await loadUser(me.id);
  if (!user?.totpEnabledAt) return { error: "Two-factor login is not on." };
  const r = await checkCode(user, String(formData.get("code") ?? ""), false);
  if ("error" in r) return { error: r.error };
  const codes = generateRecoveryCodes();
  await db.update(users).set({ totpLastStep: r.step, totpRecoveryHashes: codes.map((c) => hashRecoveryCode(c, key())), updatedAt: new Date() }).where(eq(users.id, me.id));
  await logger.warn("auth", "Two-factor recovery codes regenerated", { by: me.email, userId: me.id });
  // Not revalidated, for the same reason as confirmTwoFactorAction.
  return { ok: "New recovery codes. The old ones no longer work.", codes };
}

/** An administrator clears another user's two-factor login (lost phone and recovery codes). */
export async function adminResetTwoFactorAction(formData: FormData) {
  const admin = await assertAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  if (id === admin.id) redirect("/account#two-factor");
  await db.update(users).set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: null, updatedAt: new Date() }).where(eq(users.id, id));
  await logger.warn("auth", "Two-factor login reset by an administrator", { by: admin.email, userId: id });
  revalidatePath("/admin/users");
}
