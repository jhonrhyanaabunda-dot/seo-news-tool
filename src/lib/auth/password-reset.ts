import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { passwordResets, users } from "@/lib/db/schema";
import { sendTrackedEmail } from "@/lib/email/send";
import { renderPasswordResetEmail } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { enqueueJob } from "@/lib/jobs/queue";
import { hashPassword, validatePasswordStrength } from "./password";
import { revokeAllSessions } from "./session";

/** A link is short-lived: long enough to find the email, short enough to limit a leaked inbox. */
const TOKEN_TTL_MS = 60 * 60_000;

/** Same hashing as sessions: the database never holds a usable token. */
const hashToken = (token: string) => createHash("sha256").update(token + env().AUTH_SECRET).digest("hex");

/**
 * Issue a fresh link and email it.
 *
 * The raw token exists only inside this call: it is hashed into
 * `password_resets` and embedded in the message, and never written to the job
 * queue or the log. That is why a retry mints a *new* token rather than
 * resending the old one — the previous token cannot be recovered from its hash,
 * and a retry only happens when the previous attempt never reached anyone.
 *
 * Issuing invalidates any earlier unused link for the same user, so at most one
 * link is live at a time.
 */
export async function sendPasswordResetLink(userId: number, ip: string | null = null): Promise<"sent" | "skipped" | "failed"> {
  const [user] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!user || !user.isActive) return "skipped";

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
  // Keyed on the token's expiry, which is unique per issued link, so a retried
  // job cannot send the same link twice while a new link still gets through.
  return sendTrackedEmail({ dedupeKey: `password-reset:${user.id}:${expiresAt.getTime()}`, kind: "password_reset", to: user.email, subject, html, text });
}

/**
 * Start a reset. Always succeeds from the caller's point of view: telling an
 * anonymous visitor whether an address exists would leak who has an account.
 *
 * The first attempt is inline so the link arrives while the person is still
 * looking at their inbox. If the provider fails, a job takes over and retries
 * with backoff; the failure is recorded in `email_reports` either way, so a
 * provider outage is visible to an administrator instead of silently locking
 * someone out. The answer to the browser never changes, because varying it
 * would reveal which addresses have accounts.
 */
export async function requestPasswordReset(email: string, ip: string | null): Promise<void> {
  const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (!user || !user.isActive) {
    await logger.info("auth", "Password reset requested for an unknown or inactive address", { email, ip });
    return;
  }

  const result = await sendPasswordResetLink(user.id, ip);
  if (result === "failed") {
    // One queued job per user at a time: the partial unique index on active
    // dedupe keys stops a second request piling up another retry chain.
    await enqueueJob({ type: "password_reset", payload: { userId: user.id }, dedupeKey: `password-reset:${user.id}`, priority: 10, maxAttempts: 3 });
    await logger.warn("auth", "Password reset email failed; queued for retry", { userId: user.id, ip });
    return;
  }
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
