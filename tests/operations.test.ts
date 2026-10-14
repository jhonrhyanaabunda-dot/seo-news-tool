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
