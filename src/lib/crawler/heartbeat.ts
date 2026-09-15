import "server-only";
import { hostname } from "node:os";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlerWorkers } from "@/lib/db/schema";

/** A crawler counts as online if it reported within this window. */
export const ONLINE_WINDOW_MINUTES = 3;

/** Record that a crawler (standalone worker or Vercel tick) is alive in a region. */
export async function heartbeat(id: string, region: string, kind: "worker" | "vercel" | "cli", currentJobId: number | null = null, processedDelta = 0) {
  await db
    .insert(crawlerWorkers)
    .values({ id, region, kind, hostname: hostname().slice(0, 200), currentJobId, jobsProcessed: processedDelta })
    .onConflictDoUpdate({
      target: crawlerWorkers.id,
      set: {
        region,
        kind,
        lastSeenAt: new Date(),
        currentJobId,
        jobsProcessed: sql`${crawlerWorkers.jobsProcessed} + ${processedDelta}`,
      },
    });
}

/** Refresh only the last-seen time (keeps the current job shown on the System page intact). */
export async function touchWorker(id: string): Promise<void> {
  await db.execute(sql`update crawler_workers set last_seen_at = now() where id = ${id}`);
}

/** A standalone crawler worker (not a web-server tick) reported recently in this region. */
export async function dedicatedWorkerOnline(region: string): Promise<boolean> {
  const rows = await db.execute<{ one: number }>(sql`
    select 1 as one from crawler_workers
    where kind = 'worker' and region = ${region} and last_seen_at > now() - make_interval(mins => ${ONLINE_WINDOW_MINUTES}::int)
    limit 1
  `);
  return (rows as unknown as Array<{ one: number }>).length > 0;
}

/** Mark a worker offline on graceful shutdown, so the web app resumes crawling immediately instead of after the online window. */
export async function retireWorker(id: string): Promise<void> {
  await db.execute(sql`update crawler_workers set last_seen_at = now() - interval '1 day', current_job_id = null where id = ${id}`);
}

export async function onlineRegions(): Promise<Set<string>> {
  const rows = await db.execute<{ region: string }>(sql`
    select distinct region from crawler_workers where last_seen_at > now() - make_interval(mins => ${ONLINE_WINDOW_MINUTES}::int)
  `);
  return new Set((rows as unknown as Array<{ region: string }>).map((r) => r.region));
}
