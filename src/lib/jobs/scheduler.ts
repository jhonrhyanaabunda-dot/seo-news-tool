import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger, errorMessage } from "@/lib/logger";
import { claimPeriod, getSettings, localParts } from "@/lib/settings";
import { onlineRegions } from "@/lib/crawler/heartbeat";
import { checkCrawlerAvailability } from "@/lib/crawler/offline-alert";
import { blockedBackoffHours } from "@/lib/seo/crawl-policy";
import { createScanAndJob, logScanEvent } from "@/lib/seo/scans";
import { enqueueJob } from "./queue";

const MAX_SCANS_SCHEDULED_PER_TICK = 100;
const MAX_NEWS_SCHEDULED_PER_TICK = 200;
/** Scan jobs waiting this long for an offline region fall back to the default region. */
const REGION_FALLBACK_MINUTES = 30;

/**
 * Decide what is due and enqueue it. Safe to run from overlapping ticks:
 * scans are deduplicated by a partial unique index, news jobs by dedupe key,
 * digests/maintenance by atomic period markers.
 *
 * New dealerships are picked up automatically on the next tick
 * (last_seo_scan_at is null → due immediately). Dealerships whose recent
 * scans were blocked are retried less often (see crawl-policy).
 */
export async function scheduleDueWork(now = new Date()) {
  const s = await getSettings();
  const out = { seoQueued: 0, seoBackedOff: 0, newsQueued: 0, rerouted: 0, digests: [] as string[], maintenance: false, paused: s.schedulerPaused, crawlerAlert: null as Awaited<ReturnType<typeof checkCrawlerAvailability>> };
  // Runs even while scheduling is paused: scans that are already queued can still be stranded.
  try {
    out.crawlerAlert = await checkCrawlerAvailability(now);
  } catch (err) {
    await logger.error("crawler", "Crawler availability check failed", { error: errorMessage(err) });
  }
  if (s.schedulerPaused) return out;

  const dueSeo = await db.execute<{ id: number; interval_hours: number; last_scan: string | null; blocked_streak: number }>(sql`
    select d.id, coalesce(d.scan_interval_hours, ${s.seoIntervalHours}::int) as interval_hours, d.last_seo_scan_at as last_scan,
      (select count(*)::int from (
         select outcome from seo_scans x where x.dealership_id = d.id and x.status in ('completed', 'failed')
         order by x.created_at desc limit 3
       ) r where r.outcome = 'blocked') as blocked_streak
    from ${dealerships} d
    where d.is_active and d.seo_enabled
      and (d.last_seo_scan_at is null
           or d.last_seo_scan_at + make_interval(hours => coalesce(d.scan_interval_hours, ${s.seoIntervalHours}::int)) <= ${now.toISOString()}::timestamptz)
      and not exists (select 1 from seo_scans s where s.dealership_id = d.id and s.status in ('queued','crawling','finalizing'))
    order by d.last_seo_scan_at asc nulls first, d.id asc
    limit ${MAX_SCANS_SCHEDULED_PER_TICK}
  `);
  for (const row of dueSeo as unknown as Array<{ id: number; interval_hours: number; last_scan: string | Date | null; blocked_streak: number }>) {
    // Avoid unnecessary repeat visits to sites that keep refusing the crawler.
    if (row.last_scan && row.blocked_streak > 0) {
      const waitHours = blockedBackoffHours(Number(row.interval_hours), Number(row.blocked_streak));
      if (new Date(row.last_scan).getTime() + waitHours * 3_600_000 > now.getTime()) {
        out.seoBackedOff++;
        continue;
      }
    }
    try {
      if (await createScanAndJob(Number(row.id), "scheduled")) out.seoQueued++;
    } catch (err) {
      await logger.error("scheduler", "Failed to queue SEO scan", { error: errorMessage(err) }, Number(row.id));
    }
  }

  // Regional routing fallback: if no crawler is online in a scan's region, run it in the default region.
  const defaultRegion = env().DEFAULT_CRAWLER_REGION;
  const online = await onlineRegions();
  const waiting = await db.execute<{ id: number; region: string; payload: { scanId?: number } }>(sql`
    select id, region, payload from jobs
    where type = 'seo_scan' and status = 'queued' and region is not null and region <> ${defaultRegion}
      and created_at < now() - make_interval(mins => ${REGION_FALLBACK_MINUTES}::int)
  `);
  for (const j of waiting as unknown as Array<{ id: number; region: string; payload: { scanId?: number } }>) {
    if (online.has(j.region)) continue;
    await db.execute(sql`update jobs set region = ${defaultRegion} where id = ${j.id} and status = 'queued'`);
    if (j.payload?.scanId) {
      await db.execute(sql`update seo_scans set region = ${defaultRegion} where id = ${j.payload.scanId}`);
      await logScanEvent(j.payload.scanId, "warn", `No crawler was online in region ${j.region}; the scan was moved to the default region (${defaultRegion}).`);
    }
    out.rerouted++;
  }

  const dueNews = await db.execute<{ id: number }>(sql`
    select d.id from ${dealerships} d
    where d.is_active and d.news_enabled
      and (d.last_news_scan_at is null or d.last_news_scan_at + make_interval(hours => ${s.newsIntervalHours}::int) <= ${now.toISOString()}::timestamptz)
    order by d.last_news_scan_at asc nulls first, d.id asc
    limit ${MAX_NEWS_SCHEDULED_PER_TICK}
  `);
  for (const row of dueNews as unknown as Array<{ id: number }>) {
    const id = Number(row.id);
    const jobId = await enqueueJob({ type: "news_scan", dealershipId: id, dedupeKey: `news:${id}`, priority: 80, maxAttempts: 3 });
    // Mark as scheduled so a failing source can't cause a retry storm every tick.
    await db.update(dealerships).set({ lastNewsScanAt: now }).where(eq(dealerships.id, id));
    if (jobId) out.newsQueued++;
  }

  const local = localParts(now, env().APP_TIMEZONE);
  // SEO industry news feeds are portfolio-wide: one read per news interval, not one per dealership.
  const newsSlot = `${local.date}:${Math.floor(local.hour / Math.min(24, s.newsIntervalHours))}`;
  if (await claimPeriod("industry-news", newsSlot)) {
    if (await enqueueJob({ type: "industry_news", dedupeKey: "industry-news", priority: 90, maxAttempts: 2 })) out.newsQueued++;
  }
  if (s.dailyDigestEnabled && local.hour >= s.dailyDigestHour && (await claimPeriod("digest:daily", local.date))) {
    await enqueueJob({ type: "digest", payload: { kind: "daily", periodKey: local.date }, dedupeKey: `digest:daily:${local.date}`, priority: 30, maxAttempts: 5 });
    out.digests.push(`daily:${local.date}`);
  }
  if (s.weeklyDigestEnabled && local.weekday === s.weeklyDigestWeekday && local.hour >= s.weeklyDigestHour && (await claimPeriod("digest:weekly", local.date))) {
    await enqueueJob({ type: "digest", payload: { kind: "weekly", periodKey: local.date }, dedupeKey: `digest:weekly:${local.date}`, priority: 30, maxAttempts: 5 });
    out.digests.push(`weekly:${local.date}`);
  }
  if (await claimPeriod("maintenance", local.date)) {
    await enqueueJob({ type: "maintenance", dedupeKey: `maintenance:${local.date}`, priority: 200, maxAttempts: 2 });
    out.maintenance = true;
  }
  return out;
}

/** The earliest time any enabled dealership is next due for an SEO scan. */
export async function nextScheduledScanAt(): Promise<Date | null> {
  const s = await getSettings();
  if (s.schedulerPaused) return null;
  const rows = await db.execute<{ next: string | null }>(sql`
    select min(case when last_seo_scan_at is null then now()
      else last_seo_scan_at + make_interval(hours => coalesce(scan_interval_hours, ${s.seoIntervalHours}::int)) end) as next
    from ${dealerships} where is_active and seo_enabled
  `);
  const next = (rows as unknown as Array<{ next: string | Date | null }>)[0]?.next;
  return next ? new Date(next) : null;
}
