import "server-only";
import { env } from "@/lib/env";
import { parseServiceAccount, type ServiceAccount } from "./google-auth";

/**
 * Which Google integrations are configured. Everything degrades to a
 * "Not connected" state when the variables are absent, so a deploy without
 * them keeps working exactly as before.
 */

export interface GscConfig {
  configured: boolean;
  /** Configuration mistake to show admins (never includes the key). */
  problem: string | null;
  /** The address admins add to each Search Console property (not a secret). */
  serviceAccountEmail: string | null;
}

let cachedAccount: { account: ServiceAccount | null; problem: string | null } | null = null;

function account(): { account: ServiceAccount | null; problem: string | null } {
  if (cachedAccount) return cachedAccount;
  const e = env();
  const parsed = parseServiceAccount({ json: e.GOOGLE_SERVICE_ACCOUNT_JSON, email: e.GOOGLE_SERVICE_ACCOUNT_EMAIL, privateKey: e.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY });
  cachedAccount = parsed.ok ? { account: parsed.account, problem: null } : { account: null, problem: parsed.reason };
  return cachedAccount;
}

export function serviceAccount(): ServiceAccount | null {
  return account().account;
}

export function gscConfig(): GscConfig {
  const a = account();
  return { configured: a.account !== null, problem: a.problem, serviceAccountEmail: a.account?.clientEmail ?? null };
}

export function gscConfigured(): boolean {
  return account().account !== null;
}

export function placesConfigured(): boolean {
  return Boolean(env().GOOGLE_PLACES_API_KEY?.trim());
}

/** What the dealership form needs to know (no secrets: the service account email is meant to be shared). */
export function integrationFieldsConfig(): { serviceAccountEmail: string | null; placesEnabled: boolean } {
  return { serviceAccountEmail: gscConfig().serviceAccountEmail, placesEnabled: placesConfigured() };
}

export interface GscStatus extends GscConfig {
  /** How Search Console is reached; a service account wins when both are set. */
  method: "service_account" | "oauth" | null;
  /** OAuth: the app has a client ID/secret, so an administrator can connect. */
  oauthAvailable: boolean;
  /** OAuth: the Google account that was connected. */
  connectedEmail: string | null;
  connectedAt: string | null;
}

/** Search Console availability including a "Connect with Google" connection (a database read). */
export async function gscStatus(): Promise<GscStatus> {
  const base = gscConfig();
  const { oauthClientConfigured, getOAuthConnection } = await import("./google-oauth");
  const oauthAvailable = oauthClientConfigured();
  if (base.configured) return { ...base, method: "service_account", oauthAvailable, connectedEmail: null, connectedAt: null };
  const c = oauthAvailable ? await getOAuthConnection() : null;
  return { ...base, configured: Boolean(c), method: c ? "oauth" : null, oauthAvailable, connectedEmail: c?.email ?? null, connectedAt: c?.connectedAt ?? null };
}

export async function gscAvailable(): Promise<boolean> {
  return (await gscStatus()).configured;
}
