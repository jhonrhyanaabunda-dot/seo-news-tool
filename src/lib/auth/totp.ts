import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226 HOTP), the scheme every
 * authenticator app speaks: HMAC-SHA1, 6 digits, 30-second steps. Pure — no
 * database or environment — so it is tested directly.
 */

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps either side of "now" that are still accepted, for clocks a little out of sync. */
export const TOTP_WINDOW = 1;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding (what otpauth:// URIs carry). */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Lenient on input people type: case, spaces, dashes and padding are ignored. Throws on anything else. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s\-=]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 random bits, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP value for one counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(nowMs: number = Date.now()): number {
  return Math.floor(nowMs / 1000 / TOTP_PERIOD_SECONDS);
}

export function totpAt(secretBase32: string, nowMs: number = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

/** Digits only; people paste "123 456" or "123-456". */
export function normalizeTotpCode(code: string): string {
  return code.replace(/[\s-]/g, "");
}

export type TotpCheck = { ok: true; step: number } | { ok: false; reason: "format" | "invalid" | "replayed" };

/**
 * Check a code against now ±`TOTP_WINDOW` steps.
 *
 * `lastStep` is the highest step already accepted for this user. Any match at
 * or below it is a replay — the same code read off a shoulder, or a second tab
 * — and is refused, so each code works once. The caller must persist the
 * returned `step` (conditionally, so two concurrent requests cannot both win).
 */
export function verifyTotp(secretBase32: string, code: string, opts: { nowMs?: number; lastStep?: number | null; window?: number } = {}): TotpCheck {
  const digits = normalizeTotpCode(code);
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(digits)) return { ok: false, reason: "format" };
  let key: Buffer;
  try {
    key = base32Decode(secretBase32);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const now = totpStep(opts.nowMs ?? Date.now());
  const window = opts.window ?? TOTP_WINDOW;
  const supplied = Buffer.from(digits);
  let matched: number | null = null;
  // Check every candidate rather than stopping at the first hit, so timing does not reveal which step matched.
  for (let s = now - window; s <= now + window; s++) {
    const expected = Buffer.from(hotp(key, s));
    if (timingSafeEqual(expected, supplied) && matched === null) matched = s;
  }
  if (matched === null) return { ok: false, reason: "invalid" };
  if (opts.lastStep !== null && opts.lastStep !== undefined && matched <= opts.lastStep) return { ok: false, reason: "replayed" };
  return { ok: true, step: matched };
}

/**
 * The otpauth:// URI an authenticator app imports (Key Uri Format). The label
 * is "Issuer:account" and the issuer is repeated as a parameter, which is what
 * current apps use to group and name the entry.
 */
export function otpauthUri(secretBase32: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SECONDS) });
  return `otpauth://totp/${label}?${params.toString().replace(/\+/g, "%20")}`;
}

/** "JBSW Y3DP …" — groups of four are far easier to type into an app by hand. */
export function groupSecret(secretBase32: string): string {
  return secretBase32.replace(/(.{4})/g, "$1 ").trim();
}
