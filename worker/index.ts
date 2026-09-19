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

  while (!stopping) {
    try {
      const r = await runTick({ budgetMs: BUDGET_MS, workerId, schedule: true, role: "worker" });
      lastTick = { at: new Date().toISOString(), processed: r.processed };
      if (r.processed > 0) console.log(`[worker] processed=${r.processed} completed=${r.completed} continued=${r.continued} failed=${r.failed} in ${r.durationMs}ms`);
      if (r.processed === 0) await new Promise((res) => setTimeout(res, POLL_MS));
    } catch (err) {
      // A dropped connection (Mac waking up, Wi-Fi change) recovers on the next poll: one line, not a stack trace.
      const { isTransientNetworkError, errorMessage } = await import("@/lib/logger");
      if (isTransientNetworkError(err)) console.warn(`[worker] tick skipped: connection problem (${errorMessage(err).split("\n").pop()})`);
      else console.error("[worker] tick failed", err);
      await new Promise((res) => setTimeout(res, POLL_MS));
    }
  }
  const { closeBrowser } = await import("@/lib/seo/browser-fetch");
  await closeBrowser();
  const { retireWorker } = await import("@/lib/crawler/heartbeat");
  await retireWorker(workerId).catch(() => {});
  console.log("[worker] stopped");
  process.exit(0);
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
