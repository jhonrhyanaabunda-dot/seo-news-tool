import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { passwordResets, users } from "@/lib/db/schema";
import { sendTrackedEmail } from "@/lib/email/send";
import { renderPasswordResetEmail } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { hashPassword, validatePasswordStrength } from "./password";
import { revokeAllSessions } from "./session";

/** A link is short-lived: long enough to find the email, short enough to limit a leaked inbox. */
const TOKEN_TTL_MS = 60 * 60_000;

/** Same hashing as sessions: the database never holds a usable token. */
const hashToken = (token: string) => createHash("sha256").update(token + env().AUTH_SECRET).digest("hex");

/**
 * Start a reset. Always succeeds from the caller's point of view: telling an
 * anonymous visitor whether an address exists would leak who has an account.
 */
export async function requestPasswordReset(email: string, ip: string | null): Promise<void> {
  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (!user || !user.isActive) {
    await logger.info("auth", "Password reset requested for an unknown or inactive address", { email, ip });
    return;
  }
  // Older unused links stop working the moment a new one is issued.
  await db.update(passwordResets).set({ usedAt: new Date() }).where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  await db.insert(passwordResets).values({ userId: user.id, tokenHash: hashToken(token), expiresAt, requestedIp: ip?.slice(0, 64) ?? null });

  const dashboardUrl = env().APP_URL.replace(/\/$/, "");
  const { subject, html, text } = renderPasswordResetEmail({
    name: user.name,
    resetUrl: `${dashboardUrl}/reset-password?token=${encodeURIComponent(token)}`,
    expiresAt,
    dashboardUrl,
    timeZone: env().APP_TIMEZONE,
  });
  const result = await sendTrackedEmail({ dedupeKey: `password-reset:${user.id}:${expiresAt.getTime()}`, kind: "password_reset", to: user.email, subject, html, text });
  await logger.info("auth", `Password reset link ${result}`, { userId: user.id, ip });
}

export type ResetOutcome = { ok: true } | { ok: false; error: string };

/** Finish a reset: one-time, time-limited, and every existing session is signed out. */
export async function completePasswordReset(token: string, newPassword: string): Promise<ResetOutcome> {
  const weak = validatePasswordStrength(newPassword);
  if (weak) return { ok: false, error: weak };

  const [row] = await db
    .select()
    .from(passwordResets)
    .where(and(eq(passwordResets.tokenHash, hashToken(token)), isNull(passwordResets.usedAt), gt(passwordResets.expiresAt, new Date())))
    .limit(1);
  if (!row) return { ok: false, error: "This link has expired or has already been used. Request a new one." };

  // Constant-time compare on the stored hash, so a near-miss token can't be probed by timing.
  const supplied = Buffer.from(hashToken(token));
  const stored = Buffer.from(row.tokenHash);
  if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return { ok: false, error: "This link is not valid. Request a new one." };

  await db.update(users).set({ passwordHash: await hashPassword(newPassword), updatedAt: new Date() }).where(eq(users.id, row.userId));
  await db.update(passwordResets).set({ usedAt: new Date() }).where(eq(passwordResets.id, row.id));
  await revokeAllSessions(row.userId);
  await logger.info("auth", "Password reset completed", { userId: row.userId });
  return { ok: true };
}

/** Housekeeping: links that were never used are worthless once they expire. */
export async function pruneExpiredPasswordResets(): Promise<number> {
  const r = await db.execute(sql`delete from password_resets where expires_at < now() - interval '7 days'`);
  return (r as unknown as { count?: number }).count ?? 0;
}
