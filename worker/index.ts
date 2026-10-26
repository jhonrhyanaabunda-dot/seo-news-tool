/**
 * Optional standalone worker.
 *
 * The app works entirely on Vercel: Vercel Cron calls /api/cron/tick and each
 * tick processes resumable jobs for a few minutes. When the portfolio grows
 * beyond what those ticks can process (see README → Capacity), run this
 * worker on any container host (Railway, Render, Fly.io, ECS, Cloud Run jobs).
 * It uses the *same* job queue and code, so both can run at once safely —
 * Postgres `SKIP LOCKED` hands each job to exactly one runner.
 *
 *   npm run worker
 */
import "../scripts/load-env";
import { createServer } from "node:http";
import { hostname } from "node:os";

// Short enough that "Scan now" starts within seconds; an idle poll is one indexed query.
const POLL_MS = Number(process.env.WORKER_POLL_INTERVAL_MS ?? 5000);
const BUDGET_MS = 10 * 60_000;
let stopping = false;
let lastTick: { at: string; processed: number } | null = null;

async function main() {
  const { runTick } = await import("@/lib/jobs/runner");
  const region = process.env.WORKER_REGION || process.env.DEFAULT_CRAWLER_REGION || "us-east";
  const workerId = process.env.WORKER_ID ?? `crawler-${region}-${hostname()}-${process.pid}`;
  console.log(`[worker] ${workerId} started in region ${region} (jobs: ${process.env.WORKER_JOB_TYPES || "all"}, poll ${POLL_MS}ms)`);

  // Optional health endpoint for platforms that require an HTTP port.
  if (process.env.PORT) {
    createServer((_req, res) => {
      res.writeHead(stopping ? 503 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: !stopping, workerId, lastTick }));
    }).listen(Number(process.env.PORT));
  }

  // Consecutive failed ticks. A blip recovers on the next poll; a database that keeps refusing
  // (quota exceeded, outage) gets a slower retry, doubling up to ERROR_MAX_MS, so the worker
  // neither hammers it nor fills the log (it once wrote 100 MB of identical stack traces).
  let failures = 0;
  let lastError = "";
  while (!stopping) {
    try {
      const r = await runTick({ budgetMs: BUDGET_MS, workerId, schedule: true, role: "worker" });
      lastTick = { at: new Date().toISOString(), processed: r.processed };
      if (failures > 0) console.log(`[worker] database reachable again after ${failures} failed attempt${failures === 1 ? "" : "s"}`);
      failures = 0;
      lastError = "";
      if (r.processed > 0) console.log(`[worker] processed=${r.processed} completed=${r.completed} continued=${r.continued} failed=${r.failed} in ${r.durationMs}ms`);
      if (r.processed === 0) await sleep(POLL_MS);
    } catch (err) {
      failures++;
      const { isTransientNetworkError, errorMessage } = await import("@/lib/logger");
      const message = errorMessage(err).split("\n").pop() ?? "unknown error";
      const delay = retryDelay(failures);
      // Full detail the first time; afterwards one line when the error changes or every 50th attempt.
      if (failures === 1 && !isTransientNetworkError(err)) console.error("[worker] tick failed", err);
      else if (message !== lastError || failures % 50 === 0) console.warn(`[worker] tick failed (attempt ${failures}, retrying in ${Math.round(delay / 1000)}s): ${message}`);
      lastError = message;
      await sleep(delay);
    }
  }
  const { closeBrowser } = await import("@/lib/seo/browser-fetch");
  await closeBrowser();
  const { retireWorker } = await import("@/lib/crawler/heartbeat");
  await retireWorker(workerId).catch(() => {});
  console.log("[worker] stopped");
  process.exit(0);
}

const ERROR_MAX_MS = 5 * 60_000;

/** The first two failures retry at the normal poll interval; after that the wait doubles up to five minutes. */
function retryDelay(failures: number, pollMs = POLL_MS): number {
  if (failures <= 2) return pollMs;
  return Math.min(ERROR_MAX_MS, pollMs * 2 ** (failures - 2));
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    console.log(`[worker] ${sig} received; finishing current tick…`);
    stopping = true;
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
