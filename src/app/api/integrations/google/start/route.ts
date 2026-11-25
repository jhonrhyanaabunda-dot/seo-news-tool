import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { authorizationUrl, createOAuthState, OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_MS, oauthClientConfigured } from "@/lib/integrations/google-oauth";

export const dynamic = "force-dynamic";

/**
 * "Connect with Google" for Search Console: sends an administrator to Google's consent screen.
 * The state (also kept in a short-lived cookie) ties Google's answer to this browser and this admin.
 */
export async function GET(request: Request) {
  const user = await getCurrentUser();
  const back = new URL("/admin/system", request.url);
  if (!user || user.role !== "admin") return NextResponse.redirect(new URL("/login", request.url));
  if (!oauthClientConfigured()) {
    back.searchParams.set("google", "not-configured");
    return NextResponse.redirect(back);
  }
  const state = createOAuthState(user.id, env().AUTH_SECRET);
  const res = NextResponse.redirect(authorizationUrl(state));
  res.cookies.set(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env().NODE_ENV === "production",
    // Lax: the cookie must come back on Google's top-level redirect to the callback.
    sameSite: "lax",
    path: "/api/integrations/google",
    maxAge: OAUTH_STATE_TTL_MS / 1000,
  });
  return res;
}
