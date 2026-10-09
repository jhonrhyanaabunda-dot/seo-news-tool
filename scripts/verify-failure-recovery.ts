/**
 * Controlled failure testing for the job queue and its recovery rules.
 *
 * Every scenario runs against a development database using synthetic jobs; no
 * real scan, email or crawl is performed and no production row is touched. The
 * question each one answers is the same: when this fails, does the system
 * record the truth, and does it recover without doing the work twice?
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/verify-failure-recovery.ts
 */
import "./load-env";

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

const MARKER = "failure-check";

async function main() {
  const { db } = await import("../src/lib/db");
  const { jobs, seoScans, dealerships } = await import("../src/lib/db/schema");
  const { eq, like, and, inArray } = await import("drizzle-orm");
  const { enqueueJob, claimNextJob, recoverStaleJobs, failJobAttempt, completeJob } = await import("../src/lib/jobs/queue");

  const [dealer] = await db.select({ id: dealerships.id }).from(dealerships).limit(1);
  if (!dealer) throw new Error("need at least one dealership");

  const cleanup = async () => {
    await db.delete(jobs).where(like(jobs.dedupeKey, `${MARKER}%`));
  };
  await cleanup();

  // ── 1. duplicate cron execution ───────────────────────────────────────────
  console.log("\n1. Duplicate cron execution / duplicate enqueue");
  const a = await enqueueJob({ type: "news_scan", dealershipId: dealer.id, dedupeKey: `${MARKER}:dup`, priority: 50 });
  const b = await enqueueJob({ type: "news_scan", dealershipId: dealer.id, dedupeKey: `${MARKER}:dup`, priority: 50 });
  const dupRows = await db.select().from(jobs).where(eq(jobs.dedupeKey, `${MARKER}:dup`));
  check("a second identical enqueue is refused", Boolean(a) && !b, `first=${a} second=${b}`);
  check("exactly one row exists", dupRows.length === 1, `${dupRows.length} rows`);

  // ── 2. concurrency: two runners cannot claim the same job ─────────────────
  console.log("\n2. Concurrent claim (SKIP LOCKED)");
  const [claim1, claim2] = await Promise.all([
    claimNextJob("w1", { types: ["news_scan"], regions: ["us-east"], defaultRegion: "us-east" }),
    claimNextJob("w2", { types: ["news_scan"], regions: ["us-east"], defaultRegion: "us-east" }),
  ]);
  const bothGotIt = claim1 && claim2 && claim1.id === claim2.id;
  check("two runners never hold the same job", !bothGotIt, bothGotIt ? `both claimed ${claim1!.id}` : "");
  const mine = [claim1, claim2].find((j) => j?.dedupeKey === `${MARKER}:dup`);
  if (mine) await completeJob(mine.id, { ok: true });

  // ── 3. interrupted scan while the crawler is offline ──────────────────────
  console.log("\n3. Scan interrupted while the crawler was offline");
  await db.delete(jobs).where(eq(jobs.dedupeKey, `${MARKER}:offline`));
  await enqueueJob({ type: "seo_scan", dealershipId: dealer.id, dedupeKey: `${MARKER}:offline`, priority: 50, region: "us-east", maxAttempts: 3 });
  // Pretend a worker claimed it and then vanished.
  await db.update(jobs).set({ status: "running", lockedAt: new Date(Date.now() - 60 * 60_000), lockedBy: "dead-worker" }).where(eq(jobs.dedupeKey, `${MARKER}:offline`));
  await recoverStaleJobs(15 * 60_000, new Set()); // no region online
  const [offlineJob] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `${MARKER}:offline`));
  check("requeued, not failed", offlineJob.status === "queued", offlineJob.status);
  check("no attempt was spent", offlineJob.attempts === 0, `attempts=${offlineJob.attempts}`);
  check("the reason was recorded", Boolean(offlineJob.lastError), offlineJob.lastError ?? "none");

  // ── 4. interrupted scan while the crawler WAS online ──────────────────────
  console.log("\n4. Scan interrupted while the crawler was online (a genuine fault)");
  await db.update(jobs).set({ status: "running", lockedAt: new Date(Date.now() - 60 * 60_000), lockedBy: "dead-worker" }).where(eq(jobs.dedupeKey, `${MARKER}:offline`));
  await recoverStaleJobs(15 * 60_000, new Set(["us-east"]));
  const [faultJob] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `${MARKER}:offline`));
  check("an attempt is spent when the crawler was up", faultJob.attempts === 1, `attempts=${faultJob.attempts}`);
  check("still retried rather than failed", faultJob.status === "queued", faultJob.status);

  // ── 5. retry budget is finite ─────────────────────────────────────────────
  console.log("\n5. A job that always fails eventually fails for good");
  await db.delete(jobs).where(eq(jobs.dedupeKey, `${MARKER}:doomed`));
  await enqueueJob({ type: "news_scan", dealershipId: dealer.id, dedupeKey: `${MARKER}:doomed`, priority: 50, maxAttempts: 3 });
  let [doomed] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `${MARKER}:doomed`));
  const outcomes: boolean[] = [];
  for (let i = 0; i < 3; i++) {
    const r = await failJobAttempt(doomed, "simulated failure");
    outcomes.push(r.final);
    [doomed] = await db.select().from(jobs).where(eq(jobs.dedupeKey, `${MARKER}:doomed`));
  }
  check("does not fail early", outcomes.slice(0, 2).every((f) => !f), outcomes.join(","));
  check("fails on the last attempt", outcomes[2] === true);
  check("final state is failed", doomed.status === "failed", doomed.status);
  check("the error is retained for an admin", Boolean(doomed.lastError));
  check("backoff was applied between attempts", doomed.runAfter !== null);

  // ── 6. a failed job is never recorded as completed ────────────────────────
  console.log("\n6. Failure is never recorded as success");
  const bad = await db.select().from(jobs).where(and(like(jobs.dedupeKey, `${MARKER}%`), eq(jobs.status, "completed")));
  check("no simulated failure ended up 'completed'", bad.every((j) => j.dedupeKey !== `${MARKER}:doomed`));
  check("completedAt is set on the failed job", doomed.completedAt !== null, "needed so it shows in the failed-jobs table");

  // ── 7. worker restart: a requeued job is claimable again ──────────────────
  console.log("\n7. Worker restart");
  await db.update(jobs).set({ status: "queued", attempts: 0, runAfter: new Date(Date.now() - 1000), lockedAt: null, lockedBy: null }).where(eq(jobs.dedupeKey, `${MARKER}:offline`));
  const reclaimed = await claimNextJob("restarted-worker", { types: ["seo_scan"], regions: ["us-east"], defaultRegion: "us-east" });
  check("a new worker can pick the job back up", reclaimed?.dedupeKey === `${MARKER}:offline`, reclaimed?.dedupeKey ?? "nothing claimed");
  if (reclaimed) await completeJob(reclaimed.id, { ok: true });

  // ── 8. region isolation ───────────────────────────────────────────────────
  console.log("\n8. A worker does not steal another region's scan");
  await db.delete(jobs).where(eq(jobs.dedupeKey, `${MARKER}:eu`));
  await enqueueJob({ type: "seo_scan", dealershipId: dealer.id, dedupeKey: `${MARKER}:eu`, priority: 1, region: "eu-west" });
  const wrongRegion = await claimNextJob("us-worker", { types: ["seo_scan"], regions: ["us-east"], defaultRegion: "us-east" });
  check("a us-east worker ignores a eu-west scan", wrongRegion?.dedupeKey !== `${MARKER}:eu`, wrongRegion?.dedupeKey ?? "nothing claimed");
  if (wrongRegion) await completeJob(wrongRegion.id, { ok: true });

  // ── 9. database unavailable ───────────────────────────────────────────────
  console.log("\n9. Database unavailable");
  const postgres = (await import("postgres")).default;
  const dead = postgres("postgres://nobody@127.0.0.1:1/none", { max: 1, prepare: false, onnotice: () => {}, connect_timeout: 2 });
  let threw = false;
  try {
    await dead`select 1`;
  } catch {
    threw = true;
  } finally {
    await dead.end({ timeout: 1 }).catch(() => {});
  }
  check("an unreachable database raises rather than returning empty data", threw);

  await cleanup();
  // Nothing above creates a scan row, but assert it to be sure.
  const strayScans = await db.select({ id: seoScans.id }).from(seoScans).where(inArray(seoScans.status, ["queued"]));
  check("no stray scan rows were created", strayScans.length === 0, `${strayScans.length} queued scans`);
}

main()
  .catch((err) => failures.push(`run aborted: ${err instanceof Error ? err.stack : String(err)}`))
  .finally(() => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    for (const f of failures) console.log(`  ✖ ${f}`);
    process.exit(failures.length ? 1 : 0);
  });
