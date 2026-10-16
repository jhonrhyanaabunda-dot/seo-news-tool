import "server-only";
import { createSign } from "node:crypto";

/**
 * Google service-account authentication (OAuth 2.0 JWT bearer flow, RFC 7523)
 * without a Google SDK: an RS256-signed assertion is exchanged at the token
 * endpoint for a short-lived access token, which is cached in memory until
 * shortly before it expires.
 *
 * Nothing here reads the environment or logs: credentials come in as
 * arguments, and error messages never contain the key or the assertion.
 */

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface ServiceAccount {
  clientEmail: string;
  privateKey: string;
}

export type ServiceAccountParse = { ok: true; account: ServiceAccount } | { ok: false; reason: string | null };

/** Turn escaped line breaks ("\n" typed into an env var) into real ones and trim stray quotes. */
export function normalizePrivateKey(key: string): string {
  let k = key.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
  return k.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\r\n/g, "\n").trim();
}

/**
 * Read the service account from GOOGLE_SERVICE_ACCOUNT_JSON (raw JSON or the
 * same JSON base64-encoded) or from the EMAIL + PRIVATE_KEY pair. `reason: null`
 * means nothing is configured; a string explains a configuration mistake.
 */
export function parseServiceAccount(input: { json?: string | null; email?: string | null; privateKey?: string | null }): ServiceAccountParse {
  const json = input.json?.trim();
  if (json) {
    let text = json;
    if (!text.startsWith("{")) {
      try {
        text = Buffer.from(text, "base64").toString("utf8").trim();
      } catch {
        text = "";
      }
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, reason: "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON (paste the whole key file, or the file base64-encoded)." };
    }
    const d = data as { type?: unknown; client_email?: unknown; private_key?: unknown };
    if (typeof d.client_email !== "string" || typeof d.private_key !== "string") {
      return { ok: false, reason: "GOOGLE_SERVICE_ACCOUNT_JSON has no client_email/private_key. Use a service account key (JSON), not an OAuth client secret." };
    }
    return checkKey({ clientEmail: d.client_email.trim(), privateKey: normalizePrivateKey(d.private_key) });
  }
  const email = input.email?.trim();
  const key = input.privateKey?.trim();
  if (!email && !key) return { ok: false, reason: null };
  if (!email || !key) return { ok: false, reason: "Set both GOOGLE_SERVICE_ACCOUNT_EMAIL and GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY (or GOOGLE_SERVICE_ACCOUNT_JSON)." };
  return checkKey({ clientEmail: email, privateKey: normalizePrivateKey(key) });
}

function checkKey(account: ServiceAccount): ServiceAccountParse {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account.clientEmail)) return { ok: false, reason: "The service account email is not a valid address." };
  if (!/-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----/.test(account.privateKey)) {
    return { ok: false, reason: "The service account private key is not a PEM key (it should start with -----BEGIN PRIVATE KEY-----)." };
  }
  return { ok: true, account };
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");

/** The signed JWT assertion exchanged for an access token. `nowSeconds` is injectable for tests. */
export function buildJwtAssertion(account: ServiceAccount, scope: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "RS256", typ: "JWT" };
  const claims = { iss: account.clientEmail, scope, aud: GOOGLE_TOKEN_URL, iat: nowSeconds, exp: nowSeconds + 3600 };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  return `${unsigned}.${signer.sign(account.privateKey).toString("base64url")}`;
}

/** A failure the caller should not retry (wrong credentials, no access) versus one it may (network, 5xx, 429). */
export class GoogleApiError extends Error {
  constructor(
    message: string,
    public readonly permanent: boolean,
    public readonly status: number | null = null,
  ) {
    super(message);
    this.name = "GoogleApiError";
  }
}

/** Readable message for a token-endpoint error, e.g. {"error":"invalid_grant","error_description":"Invalid JWT Signature."}. */
export function tokenErrorMessage(status: number, body: string): GoogleApiError {
  let code = "";
  let description = "";
  try {
    const j = JSON.parse(body) as { error?: string; error_description?: string };
    code = j.error ?? "";
    description = j.error_description ?? "";
  } catch {
    /* not JSON */
  }
  const detail = [code, description].filter(Boolean).join(": ").slice(0, 200);
  const transient = status === 429 || status >= 500;
  const hint =
    code === "invalid_grant"
      ? " Check that the service account key is current (not deleted in Google Cloud) and that the server clock is correct."
      : code === "invalid_client" || code === "unauthorized_client"
        ? " The service account may have been disabled or deleted."
        : "";
  return new GoogleApiError(`Google rejected the service account sign-in (HTTP ${status}${detail ? `, ${detail}` : ""}).${hint}`, !transient, status);
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface CachedToken {
  token: string;
  expiresAt: number;
}

/**
 * In-memory access-token cache. One per process is enough: tokens last an hour,
 * and a cold start simply signs a new assertion. Concurrent callers share one
 * in-flight request.
 */
export class GoogleTokenCache {
  private tokens = new Map<string, CachedToken>();
  private inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly fetchImpl: FetchLike = (i, init) => fetch(i, init),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getAccessToken(account: ServiceAccount, scope: string): Promise<string> {
    const key = `${account.clientEmail}|${scope}`;
    const hit = this.tokens.get(key);
    // Refresh a minute early so a token never expires mid-request.
    if (hit && hit.expiresAt - 60_000 > this.now()) return hit.token;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.request(account, scope)
      .then((t) => {
        this.tokens.set(key, t);
        return t.token;
      })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  /** Forget a token Google refused (401), so the next call signs in again. */
  invalidate(account: ServiceAccount, scope: string) {
    this.tokens.delete(`${account.clientEmail}|${scope}`);
  }

  private async request(account: ServiceAccount, scope: string): Promise<CachedToken> {
    let assertion: string;
    try {
      assertion = buildJwtAssertion(account, scope, Math.floor(this.now() / 1000));
    } catch {
      throw new GoogleApiError("The service account private key could not be used to sign in (is it the complete PEM key?).", true);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString(),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new GoogleApiError(`Could not reach Google sign-in: ${err instanceof Error ? err.message : "network error"}`, false);
    }
    const body = await res.text();
    if (!res.ok) throw tokenErrorMessage(res.status, body);
    let data: { access_token?: string; expires_in?: number };
    try {
      data = JSON.parse(body);
    } catch {
      throw new GoogleApiError("Google sign-in returned an unreadable response.", false, res.status);
    }
    if (!data.access_token) throw new GoogleApiError("Google sign-in returned no access token.", false, res.status);
    const ttl = typeof data.expires_in === "number" && data.expires_in > 0 ? data.expires_in : 3600;
    return { token: data.access_token, expiresAt: this.now() + ttl * 1000 };
  }
}
