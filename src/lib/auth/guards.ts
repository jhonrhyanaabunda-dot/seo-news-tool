import "server-only";
import { redirect } from "next/navigation";
import { adminMfaRequired } from "./mfa";
import { mustEnrollMfa } from "./mfa-crypto";
import { getCurrentUser, type SessionUser } from "./session";

export class AuthError extends Error {
  constructor(
    message = "Not authorised",
    public status: 401 | 403 = 401,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Where an admin is sent to set up two-factor when the policy requires it. */
export const MFA_ENROLL_PATH = "/account?mfa=required#two-factor";

/** For pages: redirects to /login when signed out. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * For pages: redirects unless the user is an admin. With "Require two-factor
 * for admins" on, an admin who has not enrolled is sent to the Account page
 * instead — enforced here, server-side, not merely hidden in the navigation.
 */
export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/?error=forbidden");
  if (mustEnrollMfa(user, await adminMfaRequired())) redirect(MFA_ENROLL_PATH);
  return user;
}

/** For server actions / route handlers: throws instead of redirecting. */
export async function assertUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) throw new AuthError("You must be signed in.", 401);
  return user;
}

export async function assertAdmin(): Promise<SessionUser> {
  const user = await assertUser();
  if (user.role !== "admin") throw new AuthError("Administrator access is required.", 403);
  if (mustEnrollMfa(user, await adminMfaRequired())) throw new AuthError("Set up two-factor sign-in on your Account page before using administrator tools.", 403);
  return user;
}
