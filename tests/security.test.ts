import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { AUDIT_ACTIONS, AUDIT_RETENTION_DAYS, auditHref, changedKeys, parseAuditFilters, sanitizeAuditDetails } from "@/lib/audit-shared";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
/** The body of one exported function, up to the next top-level closing brace. */
const fnBody = (src: string, name: string) => {
  const start = src.indexOf(`export async function ${name}`);
  assert.ok(start >= 0, `${name} exists`);
  const rest = src.slice(start);
  return rest.slice(0, rest.indexOf("\n}\n") + 2);
};

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
    "startTwoFactorSetupAction",
    "cancelTwoFactorSetupAction",
    // One-at-a-time news review queue; triage like setArticleStatusAction.
    "reviewArticleAction",
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
  for (const name of ["loginAction", "verifySecondFactorAction", "logoutAction"]) assert.ok(fnBody(auth, name).includes("recordAudit("), `${name} is audited`);
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
