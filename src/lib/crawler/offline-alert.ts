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

/** The crawler must have been gone this long, with scans waiting, before anyone is emailed. */
export const CRAWLER_OFFLINE_ALERT_MINUTES = 120;
/** A scan queued moments ago may simply not have been picked up yet. */
const MIN_WAIT_MINUTES = 10;
/** The worker polls every few seconds; the check itself only needs to run about once a minute. */
const CHECK_INTERVAL_MS = 60_000;
const STATE_KEY = "state:crawler-offline";

interface OfflineState {
  /** Identifies one outage: e-mails are de-duplicated per outage, so a later outage always alerts again. */
  outageId: string;
  since: string;
  regions: string[];
  /** Every recipient got the offline e-mail. Until then, sending is retried on later checks. */
  notified: boolean;
}

let lastCheckAt = 0;

/** Markers written before outage ids existed were already e-mailed. */
function normalize(value: unknown): OfflineState | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Partial<OfflineState>;
  return { since: v.since ?? new Date(0).toISOString(), regions: v.regions ?? [], outageId: v.outageId ?? v.since ?? "legacy", notified: v.notified ?? true };
}

export async function checkCrawlerAvailability(now = new Date(), opts: { force?: boolean } = {}): Promise<"alerted" | "recovered" | null> {
  const e = env();
  if (e.CRAWLER_MODE !== "worker") return null;
  if (!opts.force && now.getTime() - lastCheckAt < CHECK_INTERVAL_MS) return null;
  lastCheckAt = now.getTime();

  const waiting = (await db.execute<{ region: string; n: number; oldest: string | Date }>(sql`
    select coalesce(region, ${e.DEFAULT_CRAWLER_REGION}) as region, count(*)::int as n, min(created_at) as oldest
    from jobs where type = 'seo_scan' and status = 'queued'
    group by 1
  `)) as unknown as Array<{ region: string; n: number; oldest: string | Date }>;
  const seen = (await db.execute<{ region: string; last_seen: string | Date }>(sql`
    select region, max(last_seen_at) as last_seen from crawler_workers group by region
  `)) as unknown as Array<{ region: string; last_seen: string | Date }>;
  const lastSeen = new Map(seen.map((r) => [r.region, new Date(r.last_seen).getTime()]));
  const online = await onlineRegions();
  const goneBefore = now.getTime() - CRAWLER_OFFLINE_ALERT_MINUTES * 60_000;
  const waitedBefore = now.getTime() - MIN_WAIT_MINUTES * 60_000;
  // Stranded: scans have waited a while in a region whose crawlers have all been silent for the alert window.
  const stranded = waiting.filter((w) => !online.has(w.region) && (lastSeen.get(w.region) ?? 0) <= goneBefore && new Date(w.oldest).getTime() <= waitedBefore);

  const [row] = await db.select().from(settings).where(eq(settings.key, STATE_KEY)).limit(1);
  let state = normalize(row?.value);

  if (stranded.length) {
    if (!state) {
      const fresh: OfflineState = {
        outageId: now.toISOString(),
        since: new Date(Math.min(...stranded.map((w) => new Date(w.oldest).getTime()))).toISOString(),
        regions: stranded.map((w) => w.region),
        notified: false,
      };
      // Claiming the marker is atomic, so overlapping ticks agree on one outage.
      const claimed = await db.insert(settings).values({ key: STATE_KEY, value: fresh }).onConflictDoNothing().returning({ key: settings.key });
      if (claimed.length) {
        state = fresh;
        const waitingScans = stranded.reduce((n, w) => n + Number(w.n), 0);
        await logger.warn("crawler", `No crawler online for ${fresh.regions.join(", ")}; ${waitingScans} SEO scan(s) waiting since ${fresh.since}`);
      } else {
        const [again] = await db.select().from(settings).where(eq(settings.key, STATE_KEY)).limit(1);
        state = normalize(again?.value);
      }
    }
    if (!state || state.notified) return null;
    const waitingScans = stranded.reduce((n, w) => n + Number(w.n), 0);
    if (await notify("offline", state, waitingScans, now)) {
      await db.update(settings).set({ value: { ...state, notified: true }, updatedAt: new Date() }).where(eq(settings.key, STATE_KEY));
    }
    return "alerted";
  }

  if (!state) return null;
  const crawlerBack = state.regions.some((r) => online.has(r));
  const stillWaiting = waiting.some((w) => state!.regions.includes(w.region));
  // Resolved when a crawler is back, or when nothing waits in those regions any more (scans cancelled or moved),
  // so a stale marker can never block the alert for a later outage.
  if (!crawlerBack && stillWaiting) return null;
  const released = await db.delete(settings).where(eq(settings.key, STATE_KEY)).returning({ key: settings.key });
  if (!released.length) return null;
  await logger.info("crawler", crawlerBack ? `Crawler back online for ${state.regions.join(", ")}` : `No SEO scans waiting any more for ${state.regions.join(", ")}`);
  if (crawlerBack && state.notified) await notify("online", state, 0, now);
  return "recovered";
}

/** Returns true when every recipient got the e-mail (already-sent ones are skipped by the de-duplication key). */
async function notify(status: "offline" | "online", state: OfflineState, waitingScans: number, now: Date): Promise<boolean> {
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
  let allSent = true;
  for (const to of new Set(recipients.map((r) => r.toLowerCase()))) {
    const r = await sendTrackedEmail({ dedupeKey: `crawler-${status}:${state.outageId}:${to}`, kind: "alert", to, subject, html, text, payload: { regions: state.regions, at: now.toISOString() } });
    if (r === "failed") allSent = false;
  }
  return allSent;
}
