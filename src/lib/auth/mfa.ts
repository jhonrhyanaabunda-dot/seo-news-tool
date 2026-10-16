import "server-only";
import { cookies } from "next/headers";
import { and, eq, isNotNull, isNull, or, lt, sql } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/lib/db";
import { users, type User } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { getSettings } from "@/lib/settings";
import {
  PENDING_MFA_TTL_MS,
  decryptSecret,
  deriveKey,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  matchRecoveryCode,
  passwordFingerprint,
  signPendingMfa,
  verifyPendingMfa,
  type PendingMfa,
} from "./mfa-crypto";
import { generateTotpSecret, otpauthUri, verifyTotp } from "./totp";

/**
 * Two-factor authentication (authenticator-app codes) bound to this app's keys
 * and database. The primitives live in `totp.ts` and `mfa-crypto.ts`.
 *
 * Lifecycle: `beginEnrollment` stores an encrypted secret with
 * `totp_enabled_at` still null; `confirmEnrollment` checks one code from the
 * app, switches two-factor on and returns ten recovery codes (shown once,
 * stored hashed). Sign-in then needs a code after the password — see
 * `loginAction` / `verifyMfaAction`.
 */

export const MFA_ISSUER = "A3 SEO Monitor";
export const PENDING_MFA_COOKIE = "a3_mfa_pending";

// Encryption uses MFA_ENCRYPTION_KEY when set; the cookie and code hashes are
// always keyed off AUTH_SECRET, which already guards sessions.
const encKey = () => deriveKey(env().MFA_ENCRYPTION_KEY ?? env().AUTH_SECRET, "totp-secret-encryption");
const recoveryKey = () => deriveKey(env().AUTH_SECRET, "recovery-code-hash");
const pendingKey = () => deriveKey(env().AUTH_SECRET, "pending-mfa-cookie");
const aad = (userId: number) => `user:${userId}`;

export function isMfaEnabled(u: Pick<User, "totpEnabledAt" | "totpSecretEnc">): boolean {
  return Boolean(u.totpEnabledAt && u.totpSecretEnc);
}

/** Cached per request: the "Require two-factor for admins" setting. */
export const adminMfaRequired = cache(async (): Promise<boolean> => (await getSettings()).requireAdminMfa);

export type MfaStatus =
  | { state: "off" }
  | { state: "pending"; secret: string; uri: string }
  | { state: "on"; enabledAt: Date; recoveryCodesLeft: number };

/** What the account page shows. A pending secret is decrypted only for its owner's own page. */
export async function getMfaStatus(userId: number): Promise<MfaStatus> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !u.totpSecretEnc) return { state: "off" };
  if (u.totpEnabledAt) return { state: "on", enabledAt: u.totpEnabledAt, recoveryCodesLeft: u.totpRecoveryHashes.length };
  const secret = decryptSecret(u.totpSecretEnc, encKey(), aad(u.id));
  if (!secret) return { state: "off" };
  return { state: "pending", secret, uri: otpauthUri(secret, u.email, MFA_ISSUER) };
}

/** Start (or restart) enrolment. Refuses when two-factor is already on. */
export async function beginEnrollment(userId: number): Promise<boolean> {
  const secret = generateTotpSecret();
  const rows = await db
    .update(users)
    .set({ totpSecretEnc: encryptSecret(secret, encKey(), aad(userId)), totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: [] })
    .where(and(eq(users.id, userId), isNull(users.totpEnabledAt)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/** Abandon an unconfirmed enrolment. */
export async function cancelEnrollment(userId: number): Promise<void> {
  await db.update(users).set({ totpSecretEnc: null, totpLastStep: null }).where(and(eq(users.id, userId), isNull(users.totpEnabledAt)));
}

/**
 * Finish enrolment with a code from the app. Returns the recovery codes, or
 * null when the code is wrong (or there is no pending enrolment).
 */
export async function confirmEnrollment(userId: number, code: string): Promise<string[] | null> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || !u.totpSecretEnc || u.totpEnabledAt) return null;
  const secret = decryptSecret(u.totpSecretEnc, encKey(), aad(u.id));
  if (!secret) return null;
  const check = verifyTotp(secret, code, { lastStep: u.totpLastStep });
  if (!check.ok) return null;
  const codes = generateRecoveryCodes();
  const rows = await db
    .update(users)
    .set({ totpEnabledAt: new Date(), totpLastStep: check.step, totpRecoveryHashes: codes.map((c) => hashRecoveryCode(c, recoveryKey())), updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNull(users.totpEnabledAt), eq(users.totpSecretEnc, u.totpSecretEnc)))
    .returning({ id: users.id });
  return rows.length ? codes : null;
}

/** Switch two-factor off and forget the secret and recovery codes (own account or admin reset). */
export async function clearMfa(userId: number): Promise<boolean> {
  const rows = await db
    .update(users)
    .set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null, totpRecoveryHashes: [], updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNotNull(users.totpSecretEnc)))
    .returning({ id: users.id });
  return rows.length > 0;
}

/** Replace the recovery codes (the old ones stop working). */
export async function regenerateRecoveryCodes(userId: number): Promise<string[] | null> {
  const codes = generateRecoveryCodes();
  const rows = await db
    .update(users)
    .set({ totpRecoveryHashes: codes.map((c) => hashRecoveryCode(c, recoveryKey())), updatedAt: new Date() })
    .where(and(eq(users.id, userId), isNotNull(users.totpEnabledAt)))
    .returning({ id: users.id });
  return rows.length ? codes : null;
}

/**
 * Check an authenticator code for an enrolled user and record its step.
 *
 * The step is written with a conditional update ("only if newer than the last
 * one"), so two requests racing with the same code cannot both succeed.
 */
export async function verifyUserTotp(u: User, code: string): Promise<boolean> {
  if (!isMfaEnabled(u)) return false;
  const secret = decryptSecret(u.totpSecretEnc!, encKey(), aad(u.id));
  if (!secret) return false;
  const check = verifyTotp(secret, code, { lastStep: u.totpLastStep });
  if (!check.ok) return false;
  const rows = await db
    .update(users)
    .set({ totpLastStep: check.step })
    .where(and(eq(users.id, u.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, check.step))))
    .returning({ id: users.id });
  return rows.length > 0;
}

/** Spend one recovery code. Atomic: the hash is removed only if it is still there. */
export async function consumeRecoveryCode(u: User, code: string): Promise<boolean> {
  if (!isMfaEnabled(u)) return false;
  const hash = matchRecoveryCode(code, u.totpRecoveryHashes, recoveryKey());
  if (!hash) return false;
  const rows = await db
    .update(users)
    .set({ totpRecoveryHashes: sql`${users.totpRecoveryHashes} - ${hash}::text` })
    .where(and(eq(users.id, u.id), sql`${users.totpRecoveryHashes} @> ${JSON.stringify([hash])}::jsonb`))
    .returning({ id: users.id });
  return rows.length > 0;
}

/* ── The pending-sign-in cookie ── */

/** Issued after a correct password when a code is still needed. No session exists yet. */
export async function setPendingMfa(u: Pick<User, "id" | "passwordHash">, opts: { remember: boolean; next: string }): Promise<void> {
  const p: PendingMfa = { uid: u.id, remember: opts.remember, next: opts.next.slice(0, 500), exp: Date.now() + PENDING_MFA_TTL_MS, pv: passwordFingerprint(u.passwordHash) };
  const jar = await cookies();
  jar.set(PENDING_MFA_COOKIE, signPendingMfa(p, pendingKey()), {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    maxAge: PENDING_MFA_TTL_MS / 1000,
  });
}

/** The signed pending sign-in, or null when missing, forged or expired. */
export async function readPendingMfa(): Promise<PendingMfa | null> {
  const jar = await cookies();
  return verifyPendingMfa(jar.get(PENDING_MFA_COOKIE)?.value, pendingKey());
}

export async function clearPendingMfa(): Promise<void> {
  (await cookies()).delete(PENDING_MFA_COOKIE);
}

/** A pending sign-in is only good for the account and password it was issued for. */
export function pendingMatchesUser(p: PendingMfa, u: Pick<User, "id" | "passwordHash" | "isActive">): boolean {
  return p.uid === u.id && u.isActive && p.pv === passwordFingerprint(u.passwordHash);
}
