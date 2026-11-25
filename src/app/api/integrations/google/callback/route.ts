import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { recordAudit } from "@/lib/audit";
import { logger, errorMessage } from "@/lib/logger";
import { exchangeCode, OAUTH_STATE_COOKIE, oauthClientConfigured, saveOAuthConnection, verifyOAuthState } from "@/lib/integrations/google-oauth";

export const dynamic = "force-dynamic";

/** Google's answer to "Connect with Google": checks the state, swaps the code for a refresh token, saves it encrypted. */
export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  const back = new URL("/admin/system", request.url);
  const done = (result: string) => {
    back.searchParams.set("google", result);
    const res = NextResponse.redirect(back);
    res.cookies.delete({ name: OAUTH_STATE_COOKIE, path: "/api/integrations/google" });
    return res;
  };
  if (!user || user.role !== "admin") return NextResponse.redirect(new URL("/login", request.url));
  if (!oauthClientConfigured()) return done("not-configured");

  const params = request.nextUrl.searchParams;
  if (!verifyOAuthState(params.get("state"), request.cookies.get(OAUTH_STATE_COOKIE)?.value, user.id, env().AUTH_SECRET)) return done("expired");
  // The administrator pressed "Cancel" on Google's screen.
  if (params.get("error")) return done("cancelled");
  const code = params.get("code");
  if (!code) return done("failed");

  try {
    const { refreshToken, email } = await exchangeCode(code);
    await saveOAuthConnection({ refreshToken, email, userId: user.id });
    await recordAudit({ actor: user, action: "integrations.google_connected", target: { type: "integration", id: "search_console" }, summary: `Connected Search Console with the Google account ${email ?? "(no email returned)"}`, details: { email } });
    return done("connected");
  } catch (err) {
    await logger.warn("integrations", "Connecting Search Console with Google failed", { error: errorMessage(err) });
    return done("failed");
  }
}
