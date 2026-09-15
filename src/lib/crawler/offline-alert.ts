import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { crawlerWorkers, settings, users } from "@/lib/db/schema";
import { sendTrackedEmail } from "@/lib/email/send";
import { renderCrawlerStatusEmail } from "@/lib/email/templates";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { onlineRegions } from "./heartbeat";

/**
 * With CRAWLER_MODE=worker only dedicated crawler workers run SEO scans, so if
 * the worker stops (server down, laptop asleep) scans silently pile up. This
 * emails admins once when scans have waited too long with no crawler online,
 * and once more when crawling resumes.
 */

/** Scans must have waited this long with no crawler online before anyone is emailed. */
export const CRAWLER_OFFLINE_ALERT_MINUTES = 120;
const STATE_KEY = "state:crawler-offline";

interface OfflineState {
  since: string;
  regions: string[];
}

export async function checkCrawlerAvailability(now = new Date()): Promise<"alerted" | "recovered" | null> {
  const e = env();
  if (e.CRAWLER_MODE !== "worker") return null;

  const waiting = (await db.execute<{ region: string; n: number; oldest: string | Date }>(sql`
    select coalesce(region, ${e.DEFAULT_CRAWLER_REGION}) as region, count(*)::int as n, min(created_at) as oldest
    from jobs where type = 'seo_scan' and status = 'queued'
    group by 1
  `)) as unknown as Array<{ region: string; n: number; oldest: string | Date }>;
  const online = await onlineRegions();
  const cutoff = now.getTime() - CRAWLER_OFFLINE_ALERT_MINUTES * 60_000;
  const stranded = waiting.filter((w) => !online.has(w.region) && new Date(w.oldest).getTime() <= cutoff);

  if (stranded.length) {
    const since = new Date(Math.min(...stranded.map((w) => new Date(w.oldest).getTime())));
    const state: OfflineState = { since: since.toISOString(), regions: stranded.map((w) => w.region) };
    // Claiming the marker is atomic, so overlapping ticks send the alert exactly once per outage.
    const claimed = await db.insert(settings).values({ key: STATE_KEY, value: state }).onConflictDoNothing().returning({ key: settings.key });
    if (!claimed.length) return null;
    const waitingScans = stranded.reduce((n, w) => n + Number(w.n), 0);
    await logger.warn("crawler", `No crawler online for ${state.regions.join(", ")}; ${waitingScans} SEO scan(s) waiting since ${state.since}`);
    await notify("offline", state, waitingScans, now);
    return "alerted";
  }

  // Crawling has resumed once no scan is stranded any more and a crawler is online for the regions that were down.
  const [row] = await db.select().from(settings).where(eq(settings.key, STATE_KEY)).limit(1);
  if (!row) return null;
  const state = row.value as OfflineState;
  if (!state.regions.some((r) => online.has(r))) return null;
  const released = await db.delete(settings).where(eq(settings.key, STATE_KEY)).returning({ key: settings.key });
  if (!released.length) return null;
  await logger.info("crawler", `Crawler back online for ${state.regions.join(", ")}`);
  await notify("online", state, 0, now);
  return "recovered";
}

async function notify(status: "offline" | "online", state: OfflineState, waitingScans: number, now: Date) {
  const e = env();
  const s = await getSettings();
  let recipients = s.managementRecipients;
  if (!recipients.length) {
    // Nobody configured yet: administrators still need to know.
    const admins = await db.select({ email: users.email }).from(users).where(and(eq(users.role, "admin"), eq(users.isActive, true)));
    recipients = admins.map((a) => a.email);
  }
  const [lastCrawler] = await db
    .select({ id: crawlerWorkers.id, lastSeenAt: crawlerWorkers.lastSeenAt })
    .from(crawlerWorkers)
    .where(sql`${crawlerWorkers.region} in (${sql.join(state.regions.map((r) => sql`${r}`), sql`, `)})`)
    .orderBy(desc(crawlerWorkers.lastSeenAt))
    .limit(1);
  const dashboardUrl = e.APP_URL.replace(/\/$/, "");
  const { subject, html, text } = renderCrawlerStatusEmail({
    status,
    regions: state.regions,
    waitingScans,
    since: new Date(state.since),
    lastCrawler: lastCrawler ?? null,
    systemUrl: `${dashboardUrl}/admin/system`,
    dashboardUrl,
    timeZone: e.APP_TIMEZONE,
  });
  for (const to of new Set(recipients.map((r) => r.toLowerCase()))) {
    await sendTrackedEmail({ dedupeKey: `crawler-${status}:${state.since}:${to}`, kind: "alert", to, subject, html, text, payload: { regions: state.regions, at: now.toISOString() } });
  }
}
