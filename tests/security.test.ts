import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { buildCsp, cspDirectives, cspOptionsFromEnv } from "@/lib/security/csp";
import { base32Decode, base32Encode, generateTotpSecret, groupSecret, hotp, otpauthUri, totpAt, totpStep, verifyTotp } from "@/lib/auth/totp";
import {
  PENDING_MFA_TTL_MS,
  decryptSecret,
  deriveKey,
  encryptSecret,
  generateRecoveryCodes,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  matchRecoveryCode,
  mustEnrollMfa,
  passwordFingerprint,
  signPendingMfa,
  verifyPendingMfa,
} from "@/lib/auth/mfa-crypto";
import { encodeQr, qrSvgPath, rsDivisor, rsRemainder } from "@/lib/qr";
import { AUDIT_ACTIONS, AUDIT_RETENTION_DAYS, auditHref, changedKeys, parseAuditFilters, sanitizeAuditDetails } from "@/lib/audit-shared";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** The body of one exported function, up to the next top-level closing brace. */
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const rest = src.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

/* ── Content Security Policy ──────────────────────────────────────────── */

test("the proxy enforces the CSP rather than reporting it", () => {
  const proxy = read("src/proxy.ts");
  assert.ok(proxy.includes('res.headers.set("Content-Security-Policy", CSP)'));
  assert.ok(!proxy.includes("Content-Security-Policy-Report-Only"), "report-only header is gone");
});

test("production CSP directives", () => {
  const d = cspDirectives({});
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["default-src"], ["'self'"]);
  assert.deepEqual(d["base-uri"], ["'self'"]);
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.deepEqual(d["img-src"], ["'self'", "data:", "blob:", "https:"], "remote https images (news thumbnails, logos) render");
  assert.ok(!d["script-src"].includes("'unsafe-eval'"), "no eval in production");
  assert.ok(!buildCsp({}).includes("vercel.live"), "the toolbar is not allowed in production");
  assert.deepEqual(d["connect-src"], ["'self'"]);
  const header = buildCsp({});
  assert.ok(header.startsWith("default-src 'self'; "));
  assert.ok(!/[\r\n]/.test(header), "a single header line");
  assert.ok(header.includes("frame-ancestors 'none'"));
});

test("development and Vercel previews get only what they need", () => {
  assert.ok(cspDirectives({ dev: true })["script-src"].includes("'unsafe-eval'"));
  const preview = cspDirectives({ preview: true });
  assert.ok(preview["script-src"].includes("https://vercel.live"));
  assert.ok(preview["frame-src"].includes("https://vercel.live"));
  assert.deepEqual(preview["frame-ancestors"], ["'none'"], "framing this app stays forbidden on previews too");
  assert.deepEqual(cspOptionsFromEnv({ NODE_ENV: "production", VERCEL_ENV: "production" }), { dev: false, preview: false });
  assert.deepEqual(cspOptionsFromEnv({ NODE_ENV: "production", VERCEL_ENV: "preview" }), { dev: false, preview: true });
});

test("each security header has exactly one owner", () => {
  const config = read("next.config.ts");
  const proxy = read("src/proxy.ts");
  for (const h of ["Strict-Transport-Security", "X-Content-Type-Options", "X-Frame-Options", "Referrer-Policy", "Permissions-Policy"]) {
    assert.ok(config.includes(`key: "${h}"`), `${h} set in next.config.ts`);
    assert.ok(!proxy.includes(`"${h}"`), `${h} not repeated by the proxy`);
  }
  assert.ok(!config.includes('key: "Content-Security-Policy'), "the CSP is the proxy's alone");
});

/* ── TOTP (RFC 6238 / RFC 4226) ───────────────────────────────────────── */

test("base32 follows RFC 4648", () => {
  const vectors: Array<[string, string]> = [["", ""], ["f", "MY"], ["fo", "MZXQ"], ["foo", "MZXW6"], ["foob", "MZXW6YQ"], ["fooba", "MZXW6YTB"], ["foobar", "MZXW6YTBOI"]];
  for (const [plain, enc] of vectors) {
    assert.equal(base32Encode(Buffer.from(plain)), enc);
    assert.equal(base32Decode(enc).toString(), plain);
  }
  assert.equal(base32Decode("mzxw 6ytb-oi==").toString(), "foobar", "case, spaces, dashes and padding are tolerated");
  assert.throws(() => base32Decode("MZXW1"), "1 is not base32");
});

test("RFC 6238 SHA-1 test vectors", () => {
  const key = Buffer.from("12345678901234567890");
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, code] of vectors) assert.equal(hotp(key, Math.floor(t / 30), 8), code, `T=${t}`);
  // The 6-digit form is the same truncation, modulo 10^6.
  assert.equal(totpAt(base32Encode(key), 59_000), "287082");
});

test("RFC 4226 HOTP test vectors", () => {
  const key = Buffer.from("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  expected.forEach((code, counter) => assert.equal(hotp(key, counter), code));
});

test("codes are accepted within ±1 step and refused outside it", () => {
  const secret = generateTotpSecret();
  assert.equal(base32Decode(secret).length, 20, "160-bit secret");
  const now = 1_700_000_000_000;
  const step = totpStep(now);
  const at = (s: number) => hotp(base32Decode(secret), s);
  assert.deepEqual(verifyTotp(secret, at(step), { nowMs: now }), { ok: true, step });
  assert.deepEqual(verifyTotp(secret, at(step - 1), { nowMs: now }), { ok: true, step: step - 1 });
  assert.deepEqual(verifyTotp(secret, at(step + 1), { nowMs: now }), { ok: true, step: step + 1 });
  assert.equal(verifyTotp(secret, at(step - 2), { nowMs: now }).ok, false);
  assert.equal(verifyTotp(secret, at(step + 2), { nowMs: now }).ok, false);
  assert.deepEqual(verifyTotp(secret, `${at(step).slice(0, 3)} ${at(step).slice(3)}`, { nowMs: now }), { ok: true, step }, "a pasted '123 456' works");
  assert.deepEqual(verifyTotp(secret, "12345", { nowMs: now }), { ok: false, reason: "format" });
  assert.deepEqual(verifyTotp(secret, "abcdef", { nowMs: now }), { ok: false, reason: "format" });
});

test("a code cannot be used twice (replay protection)", () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;
  const step = totpStep(now);
  const code = hotp(base32Decode(secret), step);
  const first = verifyTotp(secret, code, { nowMs: now, lastStep: null });
  assert.equal(first.ok, true);
  assert.deepEqual(verifyTotp(secret, code, { nowMs: now, lastStep: step }), { ok: false, reason: "replayed" });
  // An older (still in-window) code after a newer one was used is a replay too.
  assert.deepEqual(verifyTotp(secret, hotp(base32Decode(secret), step - 1), { nowMs: now, lastStep: step }), { ok: false, reason: "replayed" });
  // The next step's code is still fine.
  assert.equal(verifyTotp(secret, hotp(base32Decode(secret), step + 1), { nowMs: now, lastStep: step }).ok, true);
});

test("otpauth URI carries issuer, account and parameters", () => {
  const uri = otpauthUri("JBSWY3DPEHPK3PXP", "jo.smith+qa@example.com", "A3 SEO Monitor");
  assert.ok(uri.startsWith("otpauth://totp/A3%20SEO%20Monitor:jo.smith%2Bqa%40example.com?"));
  const params = new URL(uri.replace("otpauth://", "https://x/")).searchParams;
  assert.equal(params.get("secret"), "JBSWY3DPEHPK3PXP");
  assert.equal(params.get("issuer"), "A3 SEO Monitor");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
  assert.equal(params.get("algorithm"), "SHA1");
  assert.equal(groupSecret("JBSWY3DPEHPK3PXP"), "JBSW Y3DP EHPK 3PXP");
});

/* ── Secrets at rest, recovery codes, pending sign-in ─────────────────── */

test("secrets are encrypted with AES-GCM and bound to their user", () => {
  const key = deriveKey("an-auth-secret-of-sufficient-length", "totp-secret-encryption");
  assert.equal(key.length, 32);
  assert.notDeepEqual(key, deriveKey("an-auth-secret-of-sufficient-length", "pending-mfa-cookie"), "purpose-separated keys");
  const enc = encryptSecret("JBSWY3DPEHPK3PXP", key, "user:7");
  assert.ok(enc.startsWith("v1.") && !enc.includes("JBSWY3DPEHPK3PXP"));
  assert.notEqual(enc, encryptSecret("JBSWY3DPEHPK3PXP", key, "user:7"), "fresh IV every time");
  assert.equal(decryptSecret(enc, key, "user:7"), "JBSWY3DPEHPK3PXP");
  assert.equal(decryptSecret(enc, key, "user:8"), null, "copying the column to another user does not work");
  assert.equal(decryptSecret(enc, deriveKey("another-secret-entirely-000000", "totp-secret-encryption"), "user:7"), null);
  const raw = Buffer.from(enc.slice(3), "base64url");
  raw[raw.length - 1] ^= 1;
  assert.equal(decryptSecret("v1." + raw.toString("base64url"), key, "user:7"), null, "tampering is detected");
  assert.equal(decryptSecret("garbage", key, "user:7"), null);
});

test("ten single-use recovery codes, stored only as keyed hashes", () => {
  const key = deriveKey("an-auth-secret-of-sufficient-length", "recovery-code-hash");
  const codes = generateRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) {
    assert.match(c, /^[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
    assert.ok(looksLikeRecoveryCode(c));
  }
  const hashes = codes.map((c) => hashRecoveryCode(c, key));
  assert.ok(hashes.every((h) => /^[0-9a-f]{64}$/.test(h) && !codes.some((c) => h.includes(c))));
  assert.equal(matchRecoveryCode(codes[3].toLowerCase().replace("-", " "), hashes, key), hashes[3], "typing is forgiving");
  assert.equal(matchRecoveryCode("AAAAA-AAAAA", hashes, key), null);
  assert.equal(matchRecoveryCode(codes[3], hashes, deriveKey("other-secret-000000000000000", "recovery-code-hash")), null);
  assert.ok(!looksLikeRecoveryCode("123456"), "six digits are an authenticator code");
});

test("the pending-MFA cookie is signed, short-lived and tied to the password", () => {
  const key = deriveKey("an-auth-secret-of-sufficient-length", "pending-mfa-cookie");
  const now = 1_700_000_000_000;
  const p = { uid: 42, remember: false, next: "/dealerships/3", exp: now + PENDING_MFA_TTL_MS, pv: passwordFingerprint("$2a$12$hash") };
  assert.equal(PENDING_MFA_TTL_MS, 5 * 60_000);
  const token = signPendingMfa(p, key);
  assert.deepEqual(verifyPendingMfa(token, key, now), p);
  assert.equal(verifyPendingMfa(token, key, now + PENDING_MFA_TTL_MS + 1), null, "expires after five minutes");
  assert.equal(verifyPendingMfa(token, deriveKey("another-secret-entirely-000000", "pending-mfa-cookie"), now), null);
  const [body, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...p, uid: 1 })).toString("base64url");
  assert.equal(verifyPendingMfa(`${forged}.${sig}`, key, now), null, "changing the user id breaks the signature");
  assert.equal(verifyPendingMfa(`${body}.`, key, now), null);
  assert.equal(verifyPendingMfa(undefined, key, now), null);
  assert.notEqual(passwordFingerprint("$2a$12$hash"), passwordFingerprint("$2a$12$other"), "a password reset voids a half-finished sign-in");
});

test("admin two-factor policy", () => {
  assert.equal(mustEnrollMfa({ role: "admin", mfaEnabled: false }, true), true);
  assert.equal(mustEnrollMfa({ role: "admin", mfaEnabled: true }, true), false);
  assert.equal(mustEnrollMfa({ role: "admin", mfaEnabled: false }, false), false, "off by default: nobody is locked out on deploy");
  assert.equal(mustEnrollMfa({ role: "viewer", mfaEnabled: false }, true), false);
  assert.equal(mustEnrollMfa({ role: "client", mfaEnabled: false }, true), false);
  const settings = read("src/lib/settings.ts");
  assert.ok(settings.includes("requireAdminMfa: z.boolean().default(false)"));
});

test("the policy is enforced server-side in the admin guards", () => {
  const guards = read("src/lib/auth/guards.ts");
  for (const name of ["requireAdmin", "assertAdmin"]) assert.ok(fnBody(guards, name).includes("mustEnrollMfa(user, await adminMfaRequired())"), `${name} checks the policy`);
  // The account page (where enrolment happens) and the enrolment actions must stay reachable.
  assert.ok(read("src/app/(app)/account/page.tsx").includes("await requireUser()"));
  assert.ok(!read("src/app/actions/mfa.ts").includes("assertAdmin"));
});

test("a correct password alone does not create a session when two-factor is on", () => {
  const src = read("src/lib/auth/actions.ts");
  const login = fnBody(src, "loginAction");
  const mfaBranch = login.indexOf("if (isMfaEnabled(user))");
  assert.ok(mfaBranch > 0);
  assert.ok(login.indexOf("setPendingMfa(") > mfaBranch && login.indexOf("setPendingMfa(") < login.indexOf("createSession("), "pending cookie before any session");
  assert.ok(login.indexOf('redirect("/login/verify")') < login.indexOf("createSession("));
  assert.ok(login.includes("safeNextPath(parsed.data.next)"), "next is sanitised");
  const verify = fnBody(src, "verifyMfaAction");
  assert.ok(verify.includes("checkRateLimit({ key: `mfa:user:${pending.uid}`"), "code attempts are rate-limited per account");
  assert.ok(verify.includes("pendingMatchesUser(pending, user)"));
  assert.ok(verify.indexOf("createSession(") > verify.indexOf("if (!ok)"), "session only after a valid code");
  assert.ok(verify.includes("remember: pending.remember") && verify.includes("safeNextPath(pending.next)"));
});

test("password reset does not bypass two-factor", () => {
  const src = read("src/lib/auth/password-reset.ts");
  assert.ok(!src.includes("createSession"), "a reset never signs anyone in");
  assert.ok(!/totp\w*:\s*null/.test(src), "and never clears two-factor");
  assert.ok(read("src/app/(auth)/reset-password/reset-form.tsx").includes('href="/login"'), "the user goes back through sign-in");
});

/* ── QR code ───────────────────────────────────────────────────────────── */

test("Reed–Solomon matches the standard HELLO WORLD 1-M example", () => {
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  assert.deepEqual(rsRemainder(data, rsDivisor(10)), [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("QR matrices have the right size and finder patterns", () => {
  const uri = otpauthUri(generateTotpSecret(), "someone.with.a.long.address@dealership-group.example.com", "A3 SEO Monitor");
  const m = encodeQr(uri)!;
  assert.ok(m && (m.length - 17) % 4 === 0 && m.length >= 21);
  // Top-left finder: dark 7×7 ring, light ring, dark 3×3 centre.
  for (let i = 0; i < 7; i++) {
    assert.ok(m[0][i] && m[6][i] && m[i][0] && m[i][6]);
    assert.ok(!m[7][i] && !m[i][7]);
  }
  assert.ok(m[3][3] && !m[1][1]);
  // Timing pattern alternates.
  for (let i = 8; i < m.length - 8; i++) assert.equal(m[6][i], i % 2 === 0);
  assert.deepEqual(encodeQr(uri), m, "deterministic");
  const { d, size } = qrSvgPath(m);
  assert.equal(size, m.length + 8);
  assert.ok(/^(M\d+ \d+h1v1h-1z)+$/.test(d));
  assert.equal(encodeQr("x".repeat(700)), null, "too long for the supported versions");
});

/* ── Audit trail ───────────────────────────────────────────────────────── */

test("audit details never keep secrets and stay small", () => {
  const out = sanitizeAuditDetails({
    email: "a@b.c",
    password: "hunter2hunter2",
    tempPassword: "x",
    newPassword: "y",
    token: "t",
    resetToken: "t",
    code: "123456",
    recoveryCodes: ["A"],
    totpSecret: "S",
    apiKey: "k",
    keyword: "Ford dealer",
    keywordId: 4,
    nested: { authorization: "Bearer z", ok: true, deep: { deeper: { deepest: { x: 1 } } } },
    long: "z".repeat(900),
    when: new Date("2026-01-02T03:04:05Z"),
  })!;
  for (const k of ["password", "tempPassword", "newPassword", "token", "resetToken", "code", "recoveryCodes", "totpSecret", "apiKey"]) assert.equal(out[k], "[redacted]", k);
  assert.equal(out.email, "a@b.c");
  assert.equal(out.keyword, "Ford dealer", "ordinary keys that merely contain 'key' survive");
  assert.equal(out.keywordId, 4);
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.authorization, "[redacted]");
  assert.equal(nested.ok, true);
  assert.equal(((nested.deep as Record<string, unknown>).deeper as Record<string, unknown>).deepest, "[truncated]");
  assert.ok((out.long as string).length <= 501);
  assert.equal(out.when, "2026-01-02T03:04:05.000Z");
  assert.equal(sanitizeAuditDetails(undefined), null);
});

test("audit helpers: changed keys, filters and links", () => {
  assert.deepEqual(changedKeys({ a: 1, b: [1], c: "x" }, { a: 1, b: [2], d: true }), ["b", "c", "d"]);
  assert.deepEqual(parseAuditFilters({}), { page: 1, action: undefined, actor: undefined });
  assert.deepEqual(parseAuditFilters({ page: "3", action: "user.delete", actor: "12" }), { page: 3, action: "user.delete", actor: 12 });
  assert.deepEqual(parseAuditFilters({ page: "-4", action: "drop table", actor: "x" }), { page: 1, action: undefined, actor: undefined }, "unknown values are ignored, not queried");
  assert.equal(auditHref({ page: 1 }), "/admin/audit");
  assert.equal(auditHref({ page: 2, action: "auth.sign_in", actor: 5 }), "/admin/audit?action=auth.sign_in&actor=5&page=2");
  assert.equal(AUDIT_RETENTION_DAYS, 365);
});

test("every admin and staff mutation writes an audit entry", () => {
  const dir = new URL("../src/app/actions/", import.meta.url);
  const skip = new Set([
    // Read-only polling.
    "reportPdfStatusAction",
    // Any signed-in reviewer triaging news; not an administrative change.
    "setArticleStatusAction",
    "markAllReviewedAction",
    // Anonymous, before sign-in; the completion is audited in password-reset.ts.
    "requestPasswordResetAction",
    "completePasswordResetAction",
    // Navigation within an unconfirmed enrolment; nothing is switched on or off.
    "beginMfaEnrollmentAction",
    "cancelMfaEnrollmentAction",
    // A Places search that only returns candidates; saving the chosen place id is audited as dealership.update.
    "findPlaceAction",
  ]);
  const actions = new Set(Object.keys(AUDIT_ACTIONS));
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const src = read(`src/app/actions/${file}`);
    for (const [, name] of src.matchAll(/export async function (\w+)/g)) {
      if (skip.has(name)) continue;
      const body = fnBody(src, name);
      assert.ok(body.includes("recordAudit("), `${file}: ${name} must call recordAudit`);
      for (const [, action] of body.matchAll(/action: "([\w.]+)"/g)) assert.ok(actions.has(action), `${name}: unknown audit action ${action}`);
    }
  }
  const auth = read("src/lib/auth/actions.ts");
  for (const name of ["loginAction", "verifyMfaAction", "logoutAction"]) assert.ok(fnBody(auth, name).includes("recordAudit("), `${name} is audited`);
  assert.ok(fnBody(auth, "loginAction").includes('action: "auth.sign_in_failed"'));
});

test("recordAudit cannot break the action it describes, and audit rows are pruned after a year", () => {
  const src = read("src/lib/audit.ts");
  const body = src.slice(src.indexOf("export async function recordAudit"));
  assert.ok(body.trimStart().startsWith("export async function recordAudit(entry: AuditInput): Promise<void> {\n  try {"), "everything inside one try");
  assert.ok(body.includes("} catch (err) {") && !/throw /.test(body));
  assert.ok(body.includes("sanitizeAuditDetails(entry.details)"));
  const maintenance = read("src/lib/jobs/maintenance.ts");
  assert.ok(maintenance.includes("delete from audit_logs where created_at < now() - make_interval(days => ${AUDIT_RETENTION_DAYS}::int)"));
  const schema = read("src/lib/db/schema.ts");
  assert.ok(schema.includes('index("audit_logs_created_idx").on(t.createdAt)') && schema.includes('index("audit_logs_target_idx").on(t.targetType, t.targetId)'));
});

/* ── Dependency monitoring ─────────────────────────────────────────────── */

test("dependabot and the production audit run in CI", () => {
  const dependabot = read(".github/dependabot.yml");
  assert.ok(dependabot.includes('package-ecosystem: "npm"') && dependabot.includes('interval: "weekly"'));
  assert.ok(dependabot.includes('package-ecosystem: "github-actions"') && dependabot.includes('interval: "monthly"'));
  assert.ok(/update-types:\s*\n\s*- "minor"\s*\n\s*- "patch"/.test(dependabot), "minor and patch updates are grouped");
  const ci = read(".github/workflows/ci.yml");
  assert.ok(ci.includes("npm audit --omit=dev --audit-level=high"), "dev-only advisories do not fail CI");
});
