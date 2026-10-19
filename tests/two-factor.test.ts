import { test } from "node:test";
import assert from "node:assert/strict";
import {
  base32Decode, base32Encode, consumeRecoveryCode, decryptTotpSecret, encryptTotpSecret, generateRecoveryCodes, generateTotpSecret,
  hashRecoveryCode, otpauthUrl, readTicket, signTicket, totpCode, totpStep, verifyTotp,
} from "@/lib/auth/totp";

// RFC 6238 Appendix B, SHA-1: the seed is the ASCII string "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890"));
const step = (unixSeconds: number) => totpStep(unixSeconds * 1000);

test("codes match the RFC 6238 test vectors", () => {
  assert.equal(RFC_SECRET, "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.equal(totpCode(RFC_SECRET, step(59), 8), "94287082");
  assert.equal(totpCode(RFC_SECRET, step(1111111109), 8), "07081804");
  assert.equal(totpCode(RFC_SECRET, step(1234567890), 8), "89005924");
  assert.equal(totpCode(RFC_SECRET, step(2000000000), 8), "69279037");
  assert.equal(totpCode(RFC_SECRET, step(59)), "287082", "six digits is the last six of the eight");
  assert.deepEqual(base32Decode(base32Encode(Buffer.from("any bytes \x00\xff"))), Buffer.from("any bytes \x00\xff"));
});

test("a code is accepted once, within a step of clock drift, and nothing else is", () => {
  const secret = generateTotpSecret();
  const now = 1_800_000_000_000;
  const current = totpCode(secret, totpStep(now));
  const s = verifyTotp(secret, current, null, now);
  assert.equal(s, totpStep(now));
  assert.equal(verifyTotp(secret, current, s, now), null, "replay of the same code is refused");
  assert.equal(verifyTotp(secret, totpCode(secret, totpStep(now) - 1), null, now), totpStep(now) - 1, "previous step accepted (phone clock behind)");
  assert.equal(verifyTotp(secret, totpCode(secret, totpStep(now) - 3), null, now), null, "older codes refused");
  assert.equal(verifyTotp(secret, "12345", null, now), null);
  assert.equal(verifyTotp(secret, "abcdef", null, now), null);
  assert.equal(verifyTotp(secret, ` ${current.slice(0, 3)} ${current.slice(3)} `, null, now), totpStep(now), "spaces are ignored");
});

test("the secret is encrypted at rest and only the right key opens it", () => {
  const secret = generateTotpSecret();
  const enc = encryptTotpSecret(secret, "auth-secret-one-0000");
  assert.ok(!enc.includes(secret));
  assert.equal(decryptTotpSecret(enc, "auth-secret-one-0000"), secret);
  assert.throws(() => decryptTotpSecret(enc, "a-different-secret-00"));
  assert.notEqual(encryptTotpSecret(secret, "auth-secret-one-0000"), enc, "a fresh IV every time");
});

test("recovery codes are single-use and stored only as hashes", () => {
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  assert.ok(codes.every((c) => /^[a-z2-7]{4}-[a-z2-7]{4}$/.test(c)));
  const k = "auth-secret-one-0000";
  const hashes = codes.map((c) => hashRecoveryCode(c, k));
  assert.ok(hashes.every((h) => !codes.some((c) => h.includes(c.replace("-", "")))));
  const left = consumeRecoveryCode(codes[3].toUpperCase().replace("-", " "), hashes, k);
  assert.equal(left?.length, 9, "case and separators do not matter");
  assert.equal(consumeRecoveryCode(codes[3], left!, k), null, "used once only");
  assert.equal(consumeRecoveryCode("zzzz-zzzz", hashes, k), null);
});

test("the password-passed ticket is signed, short-lived and tamper-proof", () => {
  const k = "auth-secret-one-0000";
  const now = 1_800_000_000_000;
  const t = signTicket({ uid: 7, remember: true, next: "/", exp: now + 60_000 }, k);
  assert.equal(readTicket(t, k, now)?.uid, 7);
  assert.equal(readTicket(t, k, now + 61_000), null, "expired");
  assert.equal(readTicket(t, "another-secret-0000", now), null, "wrong key");
  const [body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ uid: 1, remember: true, next: "/", exp: now + 60_000 })).toString("base64url");
  assert.equal(readTicket(`${forged}.${sig}`, k, now), null, "a changed user id breaks the signature");
  assert.equal(readTicket(`${body}.`, k, now), null);
  assert.equal(readTicket(undefined, k, now), null);
});

test("the authenticator URL carries the issuer and settings apps expect", () => {
  const u = new URL(otpauthUrl("ABCDEF", "admin@a3brands.com"));
  assert.equal(u.protocol, "otpauth:");
  assert.equal(u.host, "totp");
  assert.equal(decodeURIComponent(u.pathname), "/A3 SEO Monitor:admin@a3brands.com");
  assert.equal(u.searchParams.get("secret"), "ABCDEF");
  assert.equal(u.searchParams.get("digits"), "6");
  assert.equal(u.searchParams.get("period"), "30");
});

import { readFileSync } from "node:fs";
const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (src: string, signature: string) => {
  const from = src.slice(src.indexOf(signature));
  return from.slice(0, from.indexOf("\n}\n") + 2);
};

test("a 2FA account gets no session from the password alone", () => {
  const login = fnBody(read("src/lib/auth/actions.ts"), "export async function loginAction");
  const twoFactor = login.indexOf("if (user.totpEnabledAt && user.totpSecretEnc)");
  assert.ok(twoFactor > 0);
  assert.ok(twoFactor < login.indexOf("await createSession("), "the ticket branch runs before any session is created");
  assert.ok(login.slice(twoFactor, login.indexOf("await createSession(")).includes('redirect("/login/verify")'));
  const verify = fnBody(read("src/lib/auth/actions.ts"), "export async function verifySecondFactorAction");
  assert.ok(verify.includes("readTicket(") && verify.includes("2fa:user:${ticket.uid}"), "signed ticket and per-user rate limit");
  assert.ok(verify.indexOf("jar.delete(SECOND_FACTOR_COOKIE)") < verify.indexOf("await createSession("), "the ticket is spent before the session exists");
});

test("server action files export only async functions", () => {
  for (const f of ["src/lib/auth/actions.ts", "src/app/actions/two-factor.ts"]) {
    const src = read(f);
    assert.ok(src.startsWith('"use server";'));
    assert.ok(!/^export (const|let|function |class )/m.test(src), `${f} must not export values (Next.js rejects the build)`);
  }
});

test("recovery codes stay on screen: confirming and regenerating do not refresh the page", () => {
  const src = read("src/app/actions/two-factor.ts");
  for (const name of ["confirmTwoFactorAction", "regenerateRecoveryCodesAction"]) {
    const body = fnBody(src, `export async function ${name}`);
    assert.ok(!body.includes("revalidatePath("), `${name} must not revalidate`);
    assert.ok(!/jar\.(set|delete)\(|cookies\(\)\)\.(set|delete)\(/.test(body), `${name} must not change cookies (that also re-renders)`);
  }
  const off = fnBody(src, "export async function disableTwoFactorAction");
  assert.ok(off.includes("verifyPassword(") && off.includes("checkCode(user, parsed.data.code, true)"), "turning off needs the password and a code");
  assert.ok(off.includes("delete({ name: TOTP_SETUP_COOKIE"), "a leftover setup cookie must not offer an old QR code");
  const reset = fnBody(src, "export async function adminResetTwoFactorAction");
  assert.ok(reset.includes("await assertAdmin()") && reset.includes('logger.warn("auth", "Two-factor login reset by an administrator"'));
});

test("the 2FA migration only adds nullable columns", () => {
  const sql = read("drizzle/0018_users_two_factor.sql");
  assert.equal((sql.match(/ALTER TABLE "users" ADD COLUMN/g) ?? []).length, 4);
  assert.ok(!/NOT NULL|DROP|DELETE|UPDATE/i.test(sql));
});
