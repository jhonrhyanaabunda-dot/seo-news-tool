import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { decryptTotpSecret, encryptTotpSecret } from "@/lib/auth/totp";
import { GoogleApiError } from "./google-auth";
import { defaultFetch, emailFromIdToken, OAuthTokenSource, tokenRequest, type FetchLike } from "./google-oauth-core";
export { createOAuthState, emailFromIdToken, OAUTH_STATE_TTL_MS, OAuthTokenSource, verifyOAuthState } from "./google-oauth-core";
import { GSC_SCOPE } from "./gsc";

/**
 * Search Console through "Connect with Google" (OAuth) instead of a service account key file.
 *
 * Organisations with Google's "Secure by Default" policy cannot create service account keys
 * (iam.disableServiceAccountKeyCreation). Here an administrator who already has access to the
 * dealerships' Search Console properties signs in once and grants read-only access; the app keeps
 * the refresh token (encrypted with AUTH_SECRET, like two-factor secrets) and uses it to read the
 * same Search Analytics data the service account would. Disconnecting revokes it at Google.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const OAUTH_SCOPES = ["openid", "email", GSC_SCOPE];
export const OAUTH_STATE_COOKIE = "a3_google_oauth";
const SETTINGS_KEY = "google_oauth";

export function oauthClientConfigured(): boolean {
  const e = env();
  return Boolean(e.GOOGLE_OAUTH_CLIENT_ID?.trim() && e.GOOGLE_OAUTH_CLIENT_SECRET?.trim());
}

export function oauthRedirectUri(): string {
  return `${env().APP_URL.replace(/\/$/, "")}/api/integrations/google/callback`;
}

export function authorizationUrl(state: string): string {
  const q = new URLSearchParams({
    client_id: env().GOOGLE_OAUTH_CLIENT_ID!.trim(),
    redirect_uri: oauthRedirectUri(),
    response_type: "code",
    scope: OAUTH_SCOPES.join(" "),
    // A refresh token is only issued with offline access, and prompt=consent makes Google issue a new one on reconnect.
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_AUTH_URL}?${q}`;
}

export async function exchangeCode(code: string, fetchImpl: FetchLike = defaultFetch): Promise<{ refreshToken: string; email: string | null }> {
  const e = env();
  const body = await tokenRequest(
    { code, client_id: e.GOOGLE_OAUTH_CLIENT_ID!.trim(), client_secret: e.GOOGLE_OAUTH_CLIENT_SECRET!.trim(), redirect_uri: oauthRedirectUri(), grant_type: "authorization_code" },
    fetchImpl,
  );
  const scopes = String(body.scope ?? "").split(" ");
  if (!scopes.includes(GSC_SCOPE)) throw new GoogleApiError("Search Console access was not granted. Connect again and leave the Search Console permission ticked.", true);
  if (typeof body.refresh_token !== "string") throw new GoogleApiError("Google did not return a long-lived token. Remove the app's access at myaccount.google.com/permissions and connect again.", true);
  return { refreshToken: body.refresh_token, email: emailFromIdToken(body.id_token) };
}

/* ── stored connection ── */

export interface OAuthConnection {
  email: string | null;
  connectedAt: string;
  connectedByUserId: number;
  refreshTokenEnc: string;
}

export async function getOAuthConnection(): Promise<OAuthConnection | null> {
  const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, SETTINGS_KEY)).limit(1);
  const v = row?.value as Partial<OAuthConnection> | undefined;
  return v?.refreshTokenEnc ? (v as OAuthConnection) : null;
}

export async function saveOAuthConnection(input: { refreshToken: string; email: string | null; userId: number }): Promise<void> {
  const value: OAuthConnection = { email: input.email, connectedAt: new Date().toISOString(), connectedByUserId: input.userId, refreshTokenEnc: encryptTotpSecret(input.refreshToken, env().AUTH_SECRET) };
  await db.insert(settings).values({ key: SETTINGS_KEY, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  oauthTokens.clear();
}

/** Forget the connection and revoke it at Google (best effort: it is removed here either way). */
export async function deleteOAuthConnection(fetchImpl: FetchLike = defaultFetch): Promise<void> {
  const c = await getOAuthConnection();
  await db.delete(settings).where(eq(settings.key, SETTINGS_KEY));
  oauthTokens.clear();
  if (!c) return;
  try {
    const token = decryptTotpSecret(c.refreshTokenEnc, env().AUTH_SECRET);
    await fetchImpl(GOOGLE_REVOKE_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }), signal: AbortSignal.timeout(10_000) });
  } catch {
    /* the token is already gone from the database; Google expires unused ones */
  }
}

/* ── access tokens from the saved connection ── */

/** One per process, reading the refresh token from the database each time it needs a new access token. */
export const oauthTokens = new OAuthTokenSource(
  async () => {
    const c = await getOAuthConnection();
    if (!c) throw new GoogleApiError("Search Console is not connected.", true);
    return decryptTotpSecret(c.refreshTokenEnc, env().AUTH_SECRET);
  },
  () => ({ id: env().GOOGLE_OAUTH_CLIENT_ID!.trim(), secret: env().GOOGLE_OAUTH_CLIENT_SECRET!.trim() }),
);
