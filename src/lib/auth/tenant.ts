import "server-only";
import { cache } from "react";
import { notFound } from "next/navigation";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { userDealerships } from "@/lib/db/schema";
import { AuthError, assertUser, requireUser } from "./guards";
import type { SessionUser } from "./session";

/**
 * Which dealerships a user may reach.
 *
 * `null` means "the whole portfolio" and is returned for A3 staff (`admin`,
 * `viewer`). A `client` gets the explicit list from `user_dealerships`, which
 * may be empty — an empty list denies everything rather than allowing it, so a
 * half-provisioned client account cannot read another dealership's data.
 *
 * The result is cached per request: a page that scopes several queries pays for
 * one lookup, not one per query.
 */
export const accessibleDealershipIds = cache(async (user: SessionUser): Promise<number[] | null> => {
  if (user.role === "admin" || user.role === "viewer") return null;
  const rows = await db.select({ id: userDealerships.dealershipId }).from(userDealerships).where(eq(userDealerships.userId, user.id));
  return rows.map((r) => r.id);
});

/** True when the user may read this dealership. Never trusts the caller's id. */
export async function canAccessDealership(user: SessionUser, dealershipId: number): Promise<boolean> {
  const allowed = await accessibleDealershipIds(user);
  return allowed === null || allowed.includes(dealershipId);
}

/**
 * For pages. A dealership the user may not see is reported as missing rather
 * than forbidden, so the page does not confirm that the id exists.
 */
export async function requireDealershipAccess(dealershipId: number): Promise<SessionUser> {
  const user = await requireUser();
  if (!(await canAccessDealership(user, dealershipId))) notFound();
  return user;
}

/** For server actions and route handlers: throws instead of rendering. */
export async function assertDealershipAccess(dealershipId: number): Promise<SessionUser> {
  const user = await assertUser();
  if (!(await canAccessDealership(user, dealershipId))) {
    throw new AuthError("You do not have access to this dealership.", 403);
  }
  return user;
}

/** True for dealership logins, which must not see A3's internal surfaces. */
export function isClient(user: SessionUser): boolean {
  return user.role === "client";
}
