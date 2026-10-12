import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { db } from "@/lib/db";
import { reportRenders } from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * A one-job key that lets the rendering worker open one dealership's report.
 *
 * The Mac worker has no session and cannot sign in, but the report page is
 * behind the same tenant guard as everything else. Rather than weakening that
 * guard, the application mints a key scoped to a single dealership and a single
 * render, valid for minutes, and stores only its hash — the same shape as
 * sessions and password resets elsewhere in this codebase.
 *
 * What this deliberately is not: a way in. It authorises exactly one page for
 * one dealership, it cannot be exchanged for a session, it carries no user, and
 * it dies with the render row. Authorisation for the *request* still happens in
 * the action, against the caller's own session, before any key exists.
 */

/** Long enough for a cold Chromium start and a slow page, short enough to be useless if it leaks. */
export const RENDER_TOKEN_TTL_MS = 10 * 60_000;

const hash = (token: string) => createHash("sha256").update(`report-render:${token}${env().AUTH_SECRET}`).digest("hex");

export function mintRenderToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hash(token) };
}

/**
 * Resolve a render token to the dealership it may render, or null.
 *
 * Returns null for anything not currently valid: unknown, expired, already
 * finished, or belonging to a different dealership than the URL asks for. The
 * caller treats null exactly like "not signed in", so a bad token never reveals
 * whether a dealership exists.
 */
export async function dealershipForRenderToken(token: string, dealershipId: number): Promise<number | null> {
  if (!token || token.length < 20) return null;
  const supplied = hash(token);
  const [row] = await db
    .select({ id: reportRenders.id, dealershipId: reportRenders.dealershipId, tokenHash: reportRenders.tokenHash })
    .from(reportRenders)
    .where(and(eq(reportRenders.tokenHash, supplied), eq(reportRenders.dealershipId, dealershipId), eq(reportRenders.status, "pending"), gt(reportRenders.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;

  // The row was already found by hash equality, so this adds nothing against a
  // database-read attacker; it costs one comparison and keeps the shape honest
  // for anyone who later changes the lookup.
  const a = Buffer.from(supplied);
  const b = Buffer.from(row.tokenHash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return row.dealershipId;
}
