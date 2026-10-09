/**
 * Password-reset reliability check, against a real database.
 *
 * Covers the scenarios Phase 2 asks for: a successful request, a provider
 * failure, the queued retry, an unknown recipient, an expired token, an
 * already-used token, and repeated requests.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-password-reset.ts
 *
 * The email provider is chosen once per process and cached, so the two halves
 * run as separate child processes: the delivery half against the `console`
 * provider (nothing leaves the machine), the failure half against an SMTP host
 * that refuses connections. Run it against a development database; it creates
 * and removes its own user.
 */
import "./load-env";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PHASE = process.env.RESET_CHECK_PHASE;
const EMAIL = `reset-check-${PHASE}@example.invalid`;
const NEW_PASSWORD = "ResetCheck90210";

let passed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Run both halves and total up their results. */
function runBothPhases(): never {
  // Re-run this file through tsx, which the child would otherwise lack.
  const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
  const script = process.argv[1];
  const phases: Array<[string, Record<string, string>]> = [
    ["delivery", { EMAIL_PROVIDER: "console" }],
    [
      "provider failure",
      {
        EMAIL_PROVIDER: "smtp",
        // Nothing listens here, so every send fails fast with a refused connection.
        SMTP_HOST: "127.0.0.1",
        SMTP_PORT: "587",
        SMTP_SECURE: "false",
        SMTP_USER: "",
        SMTP_PASS: "",
        EMAIL_FROM: "A3 SEO Monitor <noreply@a3brands.com>",
      },
    ],
  ];
  let failed = 0;
  for (const [label, extra] of phases) {
    console.log(`\n═══ ${label} ═══`);
    const r = spawnSync(process.execPath, [tsx, script], {
      stdio: "inherit",
      env: { ...process.env, ...extra, RESET_CHECK_PHASE: label === "delivery" ? "ok" : "fail" },
    });
    if (r.status !== 0) failed++;
  }
  process.exit(failed ? 1 : 0);
}

if (!PHASE) runBothPhases();

async function main() {
  const { db } = await import("../src/lib/db");
  const { users, passwordResets, emailReports, jobs } = await import("../src/lib/db/schema");
  const { eq, and, desc } = await import("drizzle-orm");
  const { requestPasswordReset, completePasswordReset, sendPasswordResetLink } = await import("../src/lib/auth/password-reset");
  const { hashPassword, verifyPassword } = await import("../src/lib/auth/password");

  await db.delete(users).where(eq(users.email, EMAIL));
  const [user] = await db
    .insert(users)
    .values({ email: EMAIL, name: "Reset Check", role: "viewer", passwordHash: await hashPassword("OriginalPass123") })
    .returning({ id: users.id });

  const emailRows = () => db.select().from(emailReports).where(and(eq(emailReports.kind, "password_reset"), eq(emailReports.recipients, [EMAIL]))).orderBy(desc(emailReports.id));
  const resetJobs = () => db.select().from(jobs).where(and(eq(jobs.type, "password_reset"), eq(jobs.dedupeKey, `password-reset:${user.id}`), eq(jobs.status, "queued")));

  // The console provider prints the message; the link is read back from there
  // rather than from the database, which only ever holds the hash.
  const printed: string[] = [];
  const realLog = console.log.bind(console);
  const capture = <T>(fn: () => Promise<T>) => {
    printed.length = 0;
    console.log = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
    return fn().finally(() => {
      console.log = realLog;
    });
  };
  const lastToken = () => decodeURIComponent(printed.join("\n").match(/reset-password\?token=([^"&\s)]+)/)?.[1] ?? "");

  if (PHASE === "ok") {
    console.log("\n1. Successful reset request");
    await capture(() => requestPasswordReset(EMAIL, "127.0.0.1"));
    const firstToken = lastToken();
    check("a link was issued", firstToken.length > 20);
    check("recorded as sent", (await emailRows())[0]?.status === "sent", (await emailRows())[0]?.status);
    check("no retry job queued", (await resetJobs()).length === 0);

    console.log("\n2. The token is never stored or queued in readable form");
    const [row] = await db.select().from(passwordResets).where(eq(passwordResets.userId, user.id)).orderBy(desc(passwordResets.id));
    check("database holds a 64-char hash, not the token", row.tokenHash !== firstToken && row.tokenHash.length === 64);
    const allJobs = await db.select().from(jobs).where(eq(jobs.type, "password_reset"));
    check("no token in any job payload", !JSON.stringify(allJobs).includes(firstToken));
    check("no token in the email log row", !JSON.stringify(await emailRows()).includes(firstToken));

    console.log("\n3. Requesting again supersedes the old link");
    await capture(() => requestPasswordReset(EMAIL, "127.0.0.1"));
    const secondToken = lastToken();
    check("a different link was issued", secondToken.length > 20 && secondToken !== firstToken);
    const stale = await completePasswordReset(firstToken, NEW_PASSWORD);
    check("the superseded link is refused", stale.ok === false, JSON.stringify(stale));

    console.log("\n4. Expired token");
    const [newest] = await db.select().from(passwordResets).where(eq(passwordResets.userId, user.id)).orderBy(desc(passwordResets.id));
    await db.update(passwordResets).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(passwordResets.id, newest.id));
    check("an expired link is refused", (await completePasswordReset(secondToken, NEW_PASSWORD)).ok === false);
    await db.update(passwordResets).set({ expiresAt: new Date(Date.now() + 3_600_000), usedAt: null }).where(eq(passwordResets.id, newest.id));

    console.log("\n5. A valid link works exactly once");
    const ok = await completePasswordReset(secondToken, NEW_PASSWORD);
    check("the link works", ok.ok === true, JSON.stringify(ok));
    const [after] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    check("the password actually changed", await verifyPassword(NEW_PASSWORD, after.passwordHash));
    check("reusing the same link is refused", (await completePasswordReset(secondToken, "AnotherPass123")).ok === false);
    const [unchanged] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    check("the refused reuse changed nothing", await verifyPassword(NEW_PASSWORD, unchanged.passwordHash));

    console.log("\n6. Unknown and deactivated addresses");
    await capture(() => requestPasswordReset("definitely-not-a-user@example.invalid", "127.0.0.1"));
    check("no link issued for an unknown address", lastToken() === "");
    await db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    await capture(() => requestPasswordReset(EMAIL, "127.0.0.1"));
    check("no link issued for a deactivated account", lastToken() === "");
    check("a deactivated account queues no retry", (await resetJobs()).length === 0);
    await db.update(users).set({ isActive: true }).where(eq(users.id, user.id));

    console.log("\n7. The browser answer never varies");
    const src = readFileSync(new URL("../src/app/actions/password-reset.ts", import.meta.url), "utf8");
    const action = src.slice(src.indexOf("export async function requestPasswordResetAction"));
    const sameAnswer = [...action.matchAll(/return \{ sent: true/g)].length;
    check("rate-limited and normal paths answer identically", sameAnswer >= 2, `${sameAnswer} identical returns`);
    check("no branch reveals whether an account exists", !/(no account|does not exist|not found|unknown address)/i.test(action.split("return")[0]));
  }

  if (PHASE === "fail") {
    console.log("\n1. The provider fails");
    await capture(() => requestPasswordReset(EMAIL, "127.0.0.1"));
    const row = (await emailRows())[0];
    check("recorded as failed, not sent", row?.status === "failed", `status ${row?.status ?? "no row"}`);
    check("the failure reason was stored", Boolean(row?.error), row?.error?.slice(0, 60));
    check("a retry job was queued", (await resetJobs()).length === 1, `${(await resetJobs()).length} jobs`);

    console.log("\n2. Repeated requests do not pile up retries");
    await capture(() => requestPasswordReset(EMAIL, "127.0.0.1"));
    await capture(() => requestPasswordReset(EMAIL, "127.0.0.1"));
    check("still exactly one queued retry", (await resetJobs()).length === 1, `${(await resetJobs()).length} jobs`);

    console.log("\n3. A failed send is never reported as delivered");
    const rows = await emailRows();
    check("no row claims 'sent'", rows.every((r) => r.status !== "sent"), rows.map((r) => r.status).join(","));

    console.log("\n4. The retry surfaces its failure to the queue");
    const result = await capture(() => sendPasswordResetLink(user.id));
    check("the send path reports failure", result === "failed", String(result));

    await db.delete(jobs).where(eq(jobs.dedupeKey, `password-reset:${user.id}`));
  }

  await db.delete(emailReports).where(eq(emailReports.recipients, [EMAIL]));
  await db.delete(users).where(eq(users.id, user.id));
}

main()
  .catch((err) => failures.push(`run aborted: ${err instanceof Error ? err.stack : String(err)}`))
  .finally(() => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ✖ ${f}`);
    process.exit(failures.length ? 1 : 0);
  });
