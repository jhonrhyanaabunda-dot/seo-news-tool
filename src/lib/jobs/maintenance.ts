import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSettings } from "@/lib/settings";
import { logger } from "@/lib/logger";
import { pruneSeoArticles } from "@/lib/news/seo-industry";

/** Scans per dealership whose page/issue detail rows are kept. Older scans keep their summary, score and fingerprints. */
export const DETAIL_SCANS_KEPT = 10;

/**
 * Daily housekeeping so storage stays bounded as dealership count grows.
 * Score history (seo_scans rows) is kept for `retentionDays`; detailed rows
 * only for the most recent scans per dealership.
 */
export async function runMaintenance() {
  const s = await getSettings();
  const days = s.retentionDays;
  const result: Record<string, number> = {};
  const count = (r: unknown) => (r as { count?: number }).count ?? 0;

  const prune = await db.execute<{ id: number }>(sql`
    select id from (
      select id, row_number() over (partition by dealership_id order by created_at desc) as rn
      from seo_scans where details_retained and status in ('completed', 'failed', 'cancelled')
    ) r where rn > ${DETAIL_SCANS_KEPT} limit 500
  `);
  const ids = (prune as unknown as Array<{ id: number }>).map((r) => Number(r.id));
  if (ids.length) {
    const list = sql.join(ids.map((id) => sql`${id}`), sql`, `);
    await db.execute(sql`delete from scan_pages where scan_id in (${list})`);
    await db.execute(sql`delete from seo_issues where scan_id in (${list})`);
    await db.execute(sql`delete from scan_links where scan_id in (${list})`);
    await db.execute(sql`delete from seo_checks where scan_id in (${list})`);
    await db.execute(sql`delete from scan_events where scan_id in (${list})`);
    await db.execute(sql`update seo_scans set details_retained = false, site_checks = site_checks where id in (${list})`);
  }
  result.scanDetailsPruned = ids.length;

  result.scansDeleted = count(await db.execute(sql`delete from seo_scans where created_at < now() - make_interval(days => ${days}::int) and status in ('completed','failed','cancelled')`));
  result.newsDeleted = count(
    await db.execute(sql`delete from news_articles where detected_at < now() - make_interval(days => ${days}::int) and relevance in ('new', 'not_relevant')`),
  );
  result.seoArticlesDeleted = await pruneSeoArticles(days);
  result.alertsDeleted = count(await db.execute(sql`delete from alerts where created_at < now() - make_interval(days => ${days}::int)`));
  result.emailsDeleted = count(await db.execute(sql`delete from email_reports where created_at < now() - make_interval(days => ${days}::int)`));
  result.jobsDeleted = count(await db.execute(sql`delete from jobs where status in ('completed','failed','cancelled') and created_at < now() - interval '30 days'`));
  result.logsDeleted = count(await db.execute(sql`delete from system_logs where created_at < now() - interval '90 days'`));
  result.sessionsDeleted = count(await db.execute(sql`delete from sessions where expires_at < now()`));
  result.rateLimitsDeleted = count(await db.execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`));
  // Abandoned scans (e.g. job deleted) never stay "in progress" forever.
  result.stuckScansFailed = count(
    await db.execute(sql`
      update seo_scans set status = 'failed', error_message = 'The scan did not finish within 6 hours and was stopped.', completed_at = now()
      where status in ('queued','crawling','finalizing') and created_at < now() - interval '6 hours'
    `),
  );
  await logger.info("maintenance", "Maintenance complete", result);
  return result;
}
