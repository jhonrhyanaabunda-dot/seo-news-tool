import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { GOOGLE_TOKEN_URL, GoogleApiError } from "./google-auth";

/**
 * The parts of "Connect with Google" that need no database or environment: the signed state for the
 * round trip, the token endpoint, and access tokens refreshed from a refresh token. Unit tested directly.
 */

export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/* ── state: binds the Google round trip to this browser and this administrator ── */

function hmac(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(`google-oauth:${payload}`).digest("base64url");
}

export function createOAuthState(userId: number, secret: string, now = Date.now()): string {
  const payload = `${randomBytes(16).toString("base64url")}.${userId}.${now}`;
  return `${payload}.${hmac(payload, secret)}`;
}

/** The state Google returned must equal the cookie set when the round trip started, be ours, recent, and the same administrator's. */
export function verifyOAuthState(returned: string | null, cookie: string | undefined, userId: number, secret: string, now = Date.now()): boolean {
  if (!returned || !cookie || returned.length !== cookie.length || !timingSafeEqual(Buffer.from(returned), Buffer.from(cookie))) return false;
  const parts = returned.split(".");
  if (parts.length !== 4) return false;
  const [nonce, uid, ts, sig] = parts;
  const expected = hmac(`${nonce}.${uid}.${ts}`, secret);
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const age = now - Number(ts);
  return Number(uid) === userId && Number.isFinite(age) && age >= 0 && age <= OAUTH_STATE_TTL_MS;
}

/* ── token endpoint ── */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export const defaultFetch: FetchLike = (i, init) => fetch(i, init);

export async function tokenRequest(params: Record<string, string>, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params), signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    throw new GoogleApiError(`Could not reach Google: ${err instanceof Error ? err.message : "network error"}`, false);
  }
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : "";
    const transient = res.status === 429 || res.status >= 500;
    const msg =
      code === "invalid_grant"
        ? "Google no longer accepts the saved Search Console connection (it was revoked, expired or the account's password changed). Reconnect it in Admin → System."
        : `Google rejected the request (HTTP ${res.status}${code ? `, ${code}` : ""}).`;
    throw new GoogleApiError(msg, !transient, res.status);
  }
  return body;
}

/** The email in Google's ID token. It comes straight from Google's token endpoint over TLS, so only the payload is read. */
export function emailFromIdToken(idToken: unknown): string | null {
  if (typeof idToken !== "string") return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

/** Access tokens refreshed from the stored refresh token, cached until shortly before they expire. */
export class OAuthTokenSource {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    private readonly refreshToken: () => Promise<string>,
    private readonly client: () => { id: string; secret: string },
    private readonly fetchImpl: FetchLike = defaultFetch,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 60_000 > this.now()) return this.cached.token;
    this.inflight ??= (async () => {
      try {
        const { id, secret } = this.client();
        const body = await tokenRequest({ client_id: id, client_secret: secret, refresh_token: await this.refreshToken(), grant_type: "refresh_token" }, this.fetchImpl);
        if (typeof body.access_token !== "string") throw new GoogleApiError("Google returned no access token.", false);
        this.cached = { token: body.access_token, expiresAt: this.now() + Number(body.expires_in ?? 3600) * 1000 };
        return body.access_token;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
  }

  clear(): void {
    this.cached = null;
  }
}

