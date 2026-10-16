import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * The cryptography behind two-factor sign-in, with every key passed in. Nothing
 * here reads the environment or the database, so each piece is unit-tested;
 * `mfa.ts` binds these to AUTH_SECRET / MFA_ENCRYPTION_KEY and to Postgres.
 */

/* ── Secrets at rest ──────────────────────────────────────────────────── */

/**
 * A 256-bit key for one purpose, derived with HKDF-SHA256. Separate `info`
 * strings give separate keys from the same material, so the key that encrypts
 * authenticator secrets is never the one that signs cookies.
 */
export function deriveKey(material: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(material, "utf8"), Buffer.from("a3-seo-monitor/mfa", "utf8"), Buffer.from(info, "utf8"), 32));
}

const ENC_PREFIX = "v1.";

/** AES-256-GCM. Output: "v1." + base64url(iv ‖ tag ‖ ciphertext). The user id is bound as AAD. */
export function encryptSecret(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ENC_PREFIX + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64url");
}

/**
 * Null when the value was tampered with, belongs to another user (AAD) or was
 * written under a different key. Callers treat that as "not enrolled" rather
 * than crashing the sign-in page.
 */
export function decryptSecret(enc: string, key: Buffer, aad: string): string | null {
  if (!enc.startsWith(ENC_PREFIX)) return null;
  try {
    const raw = Buffer.from(enc.slice(ENC_PREFIX.length), "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad, "utf8"));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/* ── Recovery codes ───────────────────────────────────────────────────── */

export const RECOVERY_CODE_COUNT = 10;
/** No 0/O, 1/I/L: these are read off paper. */
const RECOVERY_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Ten codes like "K7Q2M-9XHRT" (≈49 bits each). Shown once, stored only as hashes. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let s = "";
    for (let i = 0; i < 10; i++) s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Case, spaces and dashes don't matter when someone types a code back. */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Looks like a recovery code rather than a six-digit authenticator code. */
export function looksLikeRecoveryCode(code: string): boolean {
  return normalizeRecoveryCode(code).length === 10;
}

/** Keyed hash, so a database dump alone cannot be used to test guesses offline. */
export function hashRecoveryCode(code: string, key: Buffer): string {
  return createHmac("sha256", key).update(normalizeRecoveryCode(code)).digest("hex");
}

/** The stored hash this code matches, if any (constant-time per comparison). */
export function matchRecoveryCode(code: string, hashes: readonly string[], key: Buffer): string | null {
  const supplied = Buffer.from(hashRecoveryCode(code, key), "hex");
  let found: string | null = null;
  for (const h of hashes) {
    const stored = Buffer.from(h, "hex");
    if (stored.length === supplied.length && timingSafeEqual(stored, supplied) && found === null) found = h;
  }
  return found;
}

/* ── Pending sign-in (between password and code) ─────────────────────── */

export const PENDING_MFA_TTL_MS = 5 * 60_000;

export type PendingMfa = {
  /** User id. */
  uid: number;
  /** "Remember me" from the password step, applied when the session is finally created. */
  remember: boolean;
  /** Where to go afterwards; re-checked with safeNextPath before use. */
  next: string;
  /** Expiry, epoch ms. */
  exp: number;
  /** Fingerprint of the password hash: a password change kills any half-finished sign-in. */
  pv: string;
};

/** Short, non-reversible fingerprint of a password hash. */
export function passwordFingerprint(passwordHash: string): string {
  return createHash("sha256").update(passwordHash).digest("base64url").slice(0, 16);
}

/** "payload.signature", both base64url; HMAC-SHA256 over the payload. */
export function signPendingMfa(p: PendingMfa, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(p), "utf8").toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Null for anything forged, malformed or expired. */
export function verifyPendingMfa(token: string | undefined | null, key: Buffer, nowMs: number = Date.now()): PendingMfa | null {
  if (!token || token.length > 2048) return null;
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", key).update(body).digest();
  if (sig.length !== expected.length || !timingSafeEqual(sig, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Partial<PendingMfa>;
    if (typeof p.uid !== "number" || !Number.isInteger(p.uid) || p.uid <= 0) return null;
    if (typeof p.exp !== "number" || p.exp <= nowMs) return null;
    if (typeof p.pv !== "string" || typeof p.remember !== "boolean" || typeof p.next !== "string") return null;
    return { uid: p.uid, remember: p.remember, next: p.next, exp: p.exp, pv: p.pv };
  } catch {
    return null;
  }
}

/* ── Policy ───────────────────────────────────────────────────────────── */

/**
 * True when this account must set up two-factor before it may use admin pages:
 * the "Require two-factor for admins" setting is on, the account is an admin,
 * and it has not enrolled. Off by default, so a deploy never locks anyone out.
 */
export function mustEnrollMfa(user: { role: string; mfaEnabled: boolean }, requireForAdmins: boolean): boolean {
  return requireForAdmins && user.role === "admin" && !user.mfaEnabled;
}
