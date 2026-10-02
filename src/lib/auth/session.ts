import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { and, eq, gt } from "drizzle-orm";
import { cache } from "react";
import { db } from "@/lib/db";
import { sessions, users, type User } from "@/lib/db/schema";
import { env } from "@/lib/env";

export const SESSION_COOKIE = "a3_session";
const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, when "Remember me" is ticked
const SHORT_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours on a shared or public computer
const REFRESH_AFTER_MS = 60 * 60 * 1000; // touch last_seen at most hourly

/**
 * Opaque, database-backed sessions. The cookie holds a random 256-bit token;
 * only its SHA-256 hash is stored, so a database leak cannot be replayed.
 * Sessions can be revoked server-side (user deactivated, "sign out everywhere").
 */
function hashToken(token: string) {
  return createHash("sha256").update(token + env().AUTH_SECRET).digest("hex");
}

/**
 * `remember` is the sign-in page's "Remember me": with it the session lasts 14 days
 * and survives a browser restart; without it the cookie dies with the browser and
 * the session is dropped after 12 hours anyway.
 */
export async function createSession(userId: number, meta: { userAgent?: string | null; ip?: string | null; remember?: boolean }) {
  const remember = meta.remember ?? true;
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + (remember ? SESSION_TTL_MS : SHORT_SESSION_TTL_MS));
  await db.insert(sessions).values({
    userId,
    tokenHash: hashToken(token),
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 500) ?? null,
    ipAddress: meta.ip?.slice(0, 64) ?? null,
  });
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env().NODE_ENV === "production",
    path: "/",
    // No `expires` without "Remember me": the cookie is dropped when the browser closes.
    ...(remember ? { expires: expiresAt } : {}),
  });
}

export async function destroySession() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
  }
  jar.delete(SESSION_COOKIE);
}

export async function revokeAllSessions(userId: number) {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

export type SessionUser = Pick<User, "id" | "email" | "name" | "role">;

/** Resolve the current user from the cookie. Cached per request. */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (!token || token.length < 20) return null;
  const tokenHash = hashToken(token);
  const now = new Date();
  const [row] = await db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      isActive: users.isActive,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .limit(1);
  if (!row || !row.isActive) return null;
  if (now.getTime() - row.lastSeenAt.getTime() > REFRESH_AFTER_MS) {
    // fire-and-forget; not critical
    db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, row.sessionId)).catch(() => {});
  }
  return { id: row.id, email: row.email, name: row.name, role: row.role };
});
