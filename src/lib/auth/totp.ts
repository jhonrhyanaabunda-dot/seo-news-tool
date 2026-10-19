/**
 * Two-factor login with time-based one-time passwords (TOTP, RFC 6238): the
 * 6-digit, 30-second codes from Google Authenticator, Microsoft Authenticator,
 * 1Password and similar apps. Pure functions over node:crypto (no network, no
 * database), so the whole module is unit tested.
 *
 * The shared secret is stored AES-256-GCM encrypted with a key derived from
 * AUTH_SECRET, so a database leak alone does not reveal it. Recovery codes are
 * stored only as hashes, like sessions.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes from one step either side are accepted, for phone clocks a little out of sync. */
const DRIFT_STEPS = 1;

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 encoded (what authenticator apps expect). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(timeMs: number = Date.now()): number {
  return Math.floor(timeMs / 1000 / TOTP_PERIOD_SECONDS);
}

/** The code for one time step (HOTP over the step counter, RFC 4226 dynamic truncation). */
export function totpCode(secretBase32: string, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Check a code. Returns the matching step (store it as the user's last step), or
 * null. A step at or before `lastStep` is refused, so each code works only once.
 */
export function verifyTotp(secretBase32: string, code: string, lastStep: number | null, timeMs: number = Date.now()): number | null {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const now = totpStep(timeMs);
  for (let step = now - DRIFT_STEPS; step <= now + DRIFT_STEPS; step++) {
    if (lastStep !== null && step <= lastStep) continue;
    const expected = totpCode(secretBase32, step);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) return step;
  }
  return null;
}

/** The URL authenticator apps read from the QR code. */
export function otpauthUrl(secretBase32: string, account: string, issuer = "A3 SEO Monitor"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/* ─────────────────────────── secret at rest ─────────────────────────── */

const keyFrom = (authSecret: string) => createHash("sha256").update(`totp-secret:${authSecret}`).digest();

/** AES-256-GCM; output is iv.tag.ciphertext in base64url. */
export function encryptTotpSecret(secretBase32: string, authSecret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(authSecret), iv);
  const enc = Buffer.concat([cipher.update(secretBase32, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}

export function decryptTotpSecret(payload: string, authSecret: string): string {
  const [iv, tag, enc] = payload.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(authSecret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

/* ─────────────────────────── recovery codes ─────────────────────────── */

export const RECOVERY_CODE_COUNT = 10;

/** Ten codes like "k7m2-q9xd", each usable once if the phone is lost. */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(5)).toLowerCase().slice(0, 8);
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  });
}

const normaliseRecovery = (code: string) => code.toLowerCase().replace(/[^a-z2-7]/g, "");

export function hashRecoveryCode(code: string, authSecret: string): string {
  return createHash("sha256").update(`totp-recovery:${normaliseRecovery(code)}:${authSecret}`).digest("hex");
}

/** The stored hashes left after using `code`, or null when it is not one of them. */
export function consumeRecoveryCode(code: string, hashes: string[], authSecret: string): string[] | null {
  if (normaliseRecovery(code).length !== 8) return null;
  const h = hashRecoveryCode(code, authSecret);
  const i = hashes.indexOf(h);
  return i === -1 ? null : [...hashes.slice(0, i), ...hashes.slice(i + 1)];
}

/* ─────────────────────── the password-passed ticket ─────────────────────── */

/**
 * After the password step, a 2FA account gets this short-lived signed ticket
 * (in an httpOnly cookie) instead of a session. Only the code step can turn it
 * into a session, and only within its five minutes.
 */
export interface SecondFactorTicket {
  uid: number;
  remember: boolean;
  next: string;
  exp: number;
}

export const SECOND_FACTOR_TTL_MS = 5 * 60 * 1000;
/** Holds the signed ticket between the two sign-in steps (httpOnly). */
export const SECOND_FACTOR_COOKIE = "a3_2fa";
/** Holds the encrypted, not-yet-confirmed secret while 2FA is being set up (httpOnly, 10 minutes). */
export const TOTP_SETUP_COOKIE = "a3_2fa_setup";

export function signTicket(t: SecondFactorTicket, authSecret: string): string {
  const body = Buffer.from(JSON.stringify(t)).toString("base64url");
  const sig = createHmac("sha256", `2fa-ticket:${authSecret}`).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readTicket(value: string | undefined, authSecret: string, now: number = Date.now()): SecondFactorTicket | null {
  if (!value) return null;
  const [body, sig] = value.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", `2fa-ticket:${authSecret}`).update(body).digest("base64url");
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const t = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SecondFactorTicket;
    if (typeof t.uid !== "number" || typeof t.exp !== "number" || t.exp < now) return null;
    return t;
  } catch {
    return null;
  }
}
