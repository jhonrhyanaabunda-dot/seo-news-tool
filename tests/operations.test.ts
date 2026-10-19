import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (src: string, signature: string) => {
  const from = src.slice(src.indexOf(signature));
  return from.slice(0, from.indexOf("\n}\n") + 2);
};

test("a digest that fails permanently releases its day once, so the next tick retries it", () => {
  const runner = read("src/lib/jobs/runner.ts");
  assert.ok(/if \(final && job\.type === "digest"\) await releaseDigestPeriod\(job\)/.test(runner), "the final failure of a digest must release its period");
  const release = fnBody(runner, "async function releaseDigestPeriod");
  // Guarded by its own once-per-day claim: a mail server that stays down must not become a retry loop.
  assert.ok(/claimPeriod\(`digest:\$\{kind\}:retry`, period\)/.test(release), "release is limited to once per day");
  assert.ok(/releasePeriod\(`digest:\$\{kind\}`, period\)/.test(release), "releases the same key the scheduler claims");
  const scheduler = read("src/lib/jobs/scheduler.ts");
  assert.ok(scheduler.includes('claimPeriod("digest:daily", local.date)') && scheduler.includes('claimPeriod("digest:weekly", local.date)'), "scheduler keys match");
});

test("releasePeriod only clears the period it was asked to release", () => {
  const body = fnBody(read("src/lib/settings.ts"), "export async function releasePeriod");
  assert.ok(body.includes("db.delete(settings)"));
  assert.ok(/settings\.value\} = \$\{JSON\.stringify\(period\)\}::jsonb/.test(body), "a newer period must never be undone");
});

test("manual scans, news checks and cancellations record who started them", () => {
  const src = read("src/app/actions/dealerships.ts");
  assert.ok(/logger\.info\("admin", scanId \? "Manual scan queued"[^)]*by: user\.email/.test(fnBody(src, "export async function scanNowAction")));
  assert.ok(/logger\.info\("admin", "Manual news check queued", \{ by: user\.email \}/.test(fnBody(src, "export async function newsScanNowAction")));
  assert.ok(/logger\.info\("admin", "Scan cancelled", \{ by: user\.email/.test(fnBody(src, "export async function cancelScanAction")));
});

test("both email providers send Reply-To only when it is configured", () => {
  const src = read("src/lib/email/provider.ts");
  assert.equal(src.match(/\.\.\.\(env\(\)\.EMAIL_REPLY_TO \? \{ replyTo: env\(\)\.EMAIL_REPLY_TO \} : \{\}\)/g)?.length, 2);
});

test("the latest-completed-scan lookup has a matching index", () => {
  const file = readdirSync(new URL("../drizzle/", import.meta.url)).find((f) => f.startsWith("0017_"));
  assert.ok(file, "migration 0017 exists");
  const migration = read(`drizzle/${file}`);
  assert.match(migration, /CREATE INDEX "seo_scans_dealership_completed_idx" ON "seo_scans" USING btree \("dealership_id","status","completed_at"\);/);
  assert.ok(!/DESC NULLS LAST/.test(migration), "NULLS LAST would not serve the dashboard's `order by completed_at desc`");
});

test("recent OK internal link results are reused, never chained, and never cover a bad result", () => {
  const src = read("src/lib/seo/scan-engine.ts");
  const links = fnBody(src, "async function linksPhase");
  const reuse = links.slice(links.indexOf("const reuseHours"), links.indexOf("const pick ="));
  assert.ok(reuse.length > 0, "reuse runs while the link queue is prepared, before anything is requested");
  // Sources: this dealership, this website, a completed scan inside the window, a first-hand check.
  for (const cond of [
    "ps.dealership_id = ${scan.dealershipId}",
    "ps.id <> ${scan.id}",
    "ps.status = 'completed'",
    "make_interval(hours => ${reuseHours}::int)",
    "ps.website_url = ${scan.websiteUrl}",
    "pl.is_internal and pl.checked and pl.error_code is distinct from 'REUSED'",
  ])
    assert.ok(reuse.includes(cond), `source must satisfy: ${cond}`);
  // The latest result per URL decides, and only a clean OK is reused.
  assert.ok(reuse.includes("distinct on (pl.url)") && reuse.includes("order by pl.url, ps.completed_at desc"));
  assert.ok(reuse.includes("not prev.is_broken and prev.error_code is null and prev.http_status between 200 and 399"));
  assert.ok(reuse.includes("error_code = 'REUSED', is_broken = false"), "reused rows are marked so they cannot become sources");
  assert.ok(reuse.includes("l.is_internal and l.checked = false"), "only unchecked internal links of this scan are filled");
  assert.ok(links.indexOf("const reuseHours") < links.indexOf("state.linkQueue = ["), "reused links never enter the request queue");
});

test("finalize keeps exactly the rows reuse reads, and drops reused ones", () => {
  const src = read("src/lib/seo/scan-engine.ts");
  const keep = src.slice(src.indexOf("const keepReusable"), src.indexOf("const keepReusable") + 400);
  assert.ok(keep.includes("${scanLinks.isInternal} and ${scanLinks.checked} and ${scanLinks.errorCode} is null and ${scanLinks.httpStatus} between 200 and 399"));
  assert.ok(keep.includes("env().LINK_RESULT_REUSE_HOURS > 0"), "with reuse off, OK links are dropped as before");
  assert.ok(/tx\.delete\(scanLinks\)\.where\(and\(eq\(scanLinks\.scanId, scan\.id\), eq\(scanLinks\.isBroken, false\), keepReusable\)\)/.test(src));
});

test("link reuse is on by default for 72 hours and can be switched off", () => {
  const env = read("src/lib/env.ts");
  assert.match(env, /LINK_RESULT_REUSE_HOURS: z\.coerce\.number\(\)\.int\(\)\.min\(0\)\.max\(336\)\.default\(72\)/);
  assert.match(read(".env.example"), /^LINK_RESULT_REUSE_HOURS=72$/m);
});

test("preview builds never migrate the shared production database", () => {
  const src = read("scripts/migrate.ts");
  const guard = src.indexOf('process.env.VERCEL_ENV === "preview"');
  assert.ok(guard > 0, "preview builds skip migrations");
  assert.ok(guard < src.indexOf("await migrate("), "the check runs before any migration");
  assert.match(read("package.json"), /"vercel-build": "npm run db:migrate && next build"/);
});

test("a blocked site gets exactly one quick re-check before the back-off", async () => {
  const { needsBlockedRecheck, CRAWL_POLICY } = await import("@/lib/seo/crawl-policy");
  assert.equal(CRAWL_POLICY.blockedRecheckHours, 2);
  assert.equal(needsBlockedRecheck(["blocked", "completed", "completed"]), true, "first block → re-check");
  assert.equal(needsBlockedRecheck(["blocked"]), true, "a site's first-ever scan blocked → re-check");
  assert.equal(needsBlockedRecheck(["blocked", "blocked", "completed"]), false, "re-check also blocked → back-off only");
  assert.equal(needsBlockedRecheck(["completed", "blocked"]), false, "cleared → nothing to re-check");
  assert.equal(needsBlockedRecheck(["partially_blocked"]), false, "partial scans were scored; no re-check");
  assert.equal(needsBlockedRecheck([]), false);

  const scheduler = read("src/lib/jobs/scheduler.ts");
  const block = scheduler.slice(scheduler.indexOf("const recheck = await db.execute"), scheduler.indexOf("// Regional routing fallback"));
  assert.ok(block.includes("l.outcome = 'blocked'"), "only after a fully blocked scan");
  assert.ok(block.includes("make_interval(hours => ${CRAWL_POLICY.blockedRecheckHours}::int)"), "waits the re-check delay");
  assert.ok(block.includes("not exists (select 1 from seo_scans s where s.dealership_id = d.id and s.status in ('queued','crawling','finalizing'))"), "never beside a running scan");
  assert.ok(block.includes("if (!needsBlockedRecheck(row.recent_outcomes ?? [])) continue;"), "a blocked re-check is not re-checked again");
  assert.ok(scheduler.indexOf("if (s.schedulerPaused) return out;") < scheduler.indexOf("const recheck = await db.execute"), "pausing the scheduler pauses re-checks too");
});

test("every surface presents the last scan that read the site, for up to a week", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const { presentedScanOrder, presentedScanOrderSql, BLOCKED_FALLBACK_DAYS } = await import("@/lib/seo/presented-scan");
  assert.equal(BLOCKED_FALLBACK_DAYS, 7);
  const rendered = new PgDialect().sqlToQuery(presentedScanOrder[0]);
  assert.match(rendered.sql, /case when "seo_scans"\."outcome" is distinct from 'blocked' and "seo_scans"\."completed_at" > now\(\) - make_interval\(days => \$1::int\) then 0 else 1 end/);
  assert.deepEqual(rendered.params, [7]);
  assert.equal(new PgDialect().sqlToQuery(presentedScanOrderSql).sql, "case when s.outcome is distinct from 'blocked' and s.completed_at > now() - make_interval(days => 7) then 0 else 1 end, s.completed_at desc");

  for (const f of ["src/lib/queries/dealership.ts", "src/lib/queries/client-dashboard.ts", "src/lib/reports/findings.ts", "src/lib/email/reports.ts", "src/lib/news/monitor.ts"])
    assert.ok(read(f).includes(".orderBy(...presentedScanOrder)"), `${f} presents the same scan`);
  assert.ok(read("src/lib/queries/dashboard.ts").includes("order by ${presentedScanOrderSql} limit 1"), "dashboard rows present the same scan");
  // People are told when a newer check was blocked, rather than shown an older date without explanation.
  assert.ok(read("src/app/(app)/dealerships/[id]/page.tsx").includes("{latest && newerBlocked && ("));
  assert.ok(read("src/components/client-dashboard.tsx").includes("{scan?.newerBlockedAt && ("));
  assert.ok(read("src/lib/queries/dashboard.ts").includes("r.newer_blocked_at"));
});

test("backups list tables parents-first, and a reference cycle cannot stall the order", async () => {
  const { loadOrder } = await import("../scripts/backup-db");
  const order = loadOrder(["seo_scans", "dealerships", "scan_pages", "users", "user_dealerships"], [
    { child: "seo_scans", parent: "dealerships" },
    { child: "scan_pages", parent: "seo_scans" },
    { child: "user_dealerships", parent: "users" },
    { child: "user_dealerships", parent: "dealerships" },
  ]);
  assert.deepEqual(order.length, 5);
  assert.ok(order.indexOf("dealerships") < order.indexOf("seo_scans") && order.indexOf("seo_scans") < order.indexOf("scan_pages"));
  assert.ok(order.indexOf("users") < order.indexOf("user_dealerships"));
  // a ↔ b reference each other: both still appear, exactly once.
  assert.deepEqual(loadOrder(["a", "b"], [{ child: "a", parent: "b" }, { child: "b", parent: "a" }]).sort(), ["a", "b"]);
});

test("a restore refuses the production database and non-empty targets", () => {
  const src = read("scripts/restore-db.ts");
  assert.ok(src.includes("TARGET_DATABASE_URL is the production database") && src.includes('values["to-production"]'));
  assert.ok(src.includes("The target database already has dealerships; restore only into an empty database."));
  const backup = read("scripts/backup-db.ts");
  assert.ok(backup.includes('isolation level repeatable read read only'), "one consistent, read-only snapshot");
  assert.ok(/SKIP = new Set\(\["sessions", "rate_limits", "site_cache"\]\)/.test(backup), "session tokens never sit in a backup");
});

test("responses carry HSTS and an enforced CSP; health reports crawler freshness without configuration", () => {
  const proxy = read("src/proxy.ts");
  assert.ok(proxy.includes('"Strict-Transport-Security", "max-age=63072000; includeSubDomains"'));
  assert.ok(proxy.includes('"Content-Security-Policy", CSP') && proxy.includes("\"frame-ancestors 'none'\"") && proxy.includes("\"report-uri /api/csp-report\""), "enforced, with violations reported");
  assert.ok(proxy.includes('"/api/csp-report",'), "browsers report without a session");
  const health = read("src/app/api/health/route.ts");
  assert.ok(health.includes("crawler: { lastSeenMinutesAgo: mins }"));
  assert.ok(!/region|hostname|worker_id|\bid\b,/.test(health.slice(health.indexOf("select floor"), health.indexOf("as mins"))), "a number only");
  const uptime = read(".github/workflows/uptime.yml");
  assert.ok(uptime.includes('cron: "*/15 * * * *"') && uptime.includes('[ "$mins" -gt 20 ]'));
});
