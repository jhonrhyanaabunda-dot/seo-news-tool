import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import type { ScanChangeSummary } from "@/lib/db/schema";
import type { DealerStatus } from "@/components/ui";
import { nextScheduledScanAt } from "@/lib/jobs/scheduler";

export interface DealerRow {
  id: number;
  name: string;
  brand: string;
  city: string | null;
  state: string | null;
  websiteUrl: string;
  seoEnabled: boolean;
  newsEnabled: boolean;
  isActive: boolean;
  score: number | null;
  scoreDelta: number | null;
  critical: number;
  warnings: number;
  newNews: number;
  lastScanAt: string | null;
  status: DealerStatus;
  statusDetail: string | null;
  /** Pages analysed in the latest completed scan. */
  pagesAnalyzed: number;
  /** Pages the website's security prevented the monitor from analysing (latest completed scan). */
  pagesProtected: number;
  platform: string | null;
  lastSuccessfulScanAt: string | null;
}

type RawRow = {
  id: number;
  name: string;
  brand: string;
  city: string | null;
  state: string | null;
  website_url: string;
  seo_enabled: boolean;
  news_enabled: boolean;
  is_active: boolean;
  score: number | null;
  critical_count: number | null;
  warning_count: number | null;
  completed_at: Date | string | null;
  site_available: boolean | null;
  change_summary: ScanChangeSummary | null;
  blocked_reason: string | null;
  audit_mode: string | null;
  outcome: string | null;
  active_status: string | null;
  last_status: string | null;
  last_error: string | null;
  new_news: number;
  pages_scanned: number | null;
  pages_protected: number | null;
  website_platform: string | null;
  detected_platform: string | null;
  last_successful_scan_at: Date | string | null;
};

function deriveStatus(r: RawRow): { status: DealerStatus; detail: string | null } {
  if (!r.is_active || !r.seo_enabled) return { status: "paused", detail: !r.is_active ? "Dealership is inactive" : "SEO monitoring disabled" };
  if (r.active_status) return { status: "scanning", detail: null };
  if (r.last_status === "failed") return { status: "failed", detail: r.last_error };
  if (r.completed_at === null) return { status: "not_scanned", detail: null };
  if (r.site_available === false) return { status: "down", detail: "The homepage could not be loaded during the last scan." };
  if (r.blocked_reason && r.audit_mode === "remote") return { status: "limited", detail: "The website's security prevented a direct scan; only a limited homepage check through Google PageSpeed Insights was possible." };
  if (r.blocked_reason) return { status: "blocked", detail: r.blocked_reason === "robots" ? "robots.txt disallows the monitor" : "The website's security (e.g. Cloudflare) prevented the monitor from analysing it. Not an SEO problem." };
  if (r.outcome === "partially_blocked") return { status: "partially_blocked", detail: "Some pages could not be evaluated because the website restricted automated access." };
  if ((r.critical_count ?? 0) > 0) return { status: "critical", detail: null };
  if ((r.warning_count ?? 0) > 10 || (r.score ?? 100) < 75) return { status: "attention", detail: null };
  return { status: "healthy", detail: null };
}

export async function getDealerRows(): Promise<DealerRow[]> {
  const rows = await db.execute<RawRow>(sql`
    select d.id, d.name, d.brand, d.city, d.state, d.website_url, d.seo_enabled, d.news_enabled, d.is_active,
      d.website_platform, d.detected_platform, d.last_successful_scan_at,
      ls.score, ls.critical_count, ls.warning_count, ls.completed_at, ls.site_available, ls.change_summary, ls.blocked_reason, ls.audit_mode, ls.outcome,
      ls.pages_scanned, ls.pages_protected,
      act.status as active_status, lst.status as last_status, lst.error_message as last_error,
      coalesce(nn.n, 0)::int as new_news
    from dealerships d
    left join lateral (
      select score, critical_count, warning_count, completed_at, site_available, change_summary, site_checks->>'blockedReason' as blocked_reason, site_checks->>'auditMode' as audit_mode, outcome,
        pages_scanned, pages_blocked + pages_not_evaluated as pages_protected
      from seo_scans s where s.dealership_id = d.id and s.status = 'completed'
      order by s.completed_at desc limit 1
    ) ls on true
    left join lateral (
      select status from seo_scans s where s.dealership_id = d.id and s.status in ('queued','crawling','finalizing') limit 1
    ) act on true
    left join lateral (
      select status, error_message from seo_scans s where s.dealership_id = d.id and s.status in ('completed','failed')
      order by s.created_at desc limit 1
    ) lst on true
    left join lateral (
      select count(*) as n from news_articles n where n.dealership_id = d.id and n.relevance = 'new' and n.scope = 'dealership'
    ) nn on true
    order by d.name asc
  `);
  return (rows as unknown as RawRow[]).map((r) => {
    const { status, detail } = deriveStatus(r);
    return {
      id: r.id,
      name: r.name,
      brand: r.brand,
      city: r.city,
      state: r.state,
      websiteUrl: r.website_url,
      seoEnabled: r.seo_enabled,
      newsEnabled: r.news_enabled,
      isActive: r.is_active,
      score: r.site_available === false ? null : r.score,
      scoreDelta: r.change_summary?.scoreDelta ?? null,
      critical: r.critical_count ?? 0,
      warnings: r.warning_count ?? 0,
      newNews: Number(r.new_news),
      lastScanAt: r.completed_at ? new Date(r.completed_at).toISOString() : null,
      status,
      statusDetail: detail,
      pagesAnalyzed: Math.max(0, Number(r.pages_scanned ?? 0)),
      pagesProtected: Number(r.pages_protected ?? 0),
      platform: r.website_platform ?? r.detected_platform ?? null,
      lastSuccessfulScanAt: r.last_successful_scan_at ? new Date(r.last_successful_scan_at).toISOString() : null,
    };
  });
}

export async function getDashboardSummary(rows: DealerRow[]) {
  const active = rows.filter((r) => r.isActive);
  const scored = active.filter((r) => r.score !== null);
  const [agg] = (await db.execute<{ last_scan: Date | string | null; failures: number; new_news: number }>(sql`
    select
      (select max(completed_at) from seo_scans where status = 'completed') as last_scan,
      (select count(*)::int from seo_scans where status = 'failed' and created_at > now() - interval '7 days') as failures,
      (select count(*)::int from news_articles n join dealerships d on d.id = n.dealership_id
        where n.relevance = 'new' and n.scope = 'dealership' and d.is_active) as new_news
  `)) as unknown as Array<{ last_scan: Date | string | null; failures: number; new_news: number }>;
  return {
    generatedAt: Date.now(),
    totalDealerships: active.length,
    scanned: active.filter((r) => r.lastScanAt !== null).length,
    averageScore: scored.length ? Math.round(scored.reduce((a, r) => a + (r.score ?? 0), 0) / scored.length) : null,
    critical: active.reduce((a, r) => a + r.critical, 0),
    warnings: active.reduce((a, r) => a + r.warnings, 0),
    newNews: Number(agg?.new_news ?? 0),
    lastScan: agg?.last_scan ? new Date(agg.last_scan) : null,
    nextScan: await nextScheduledScanAt(),
    scanFailures: Number(agg?.failures ?? 0),
    sitesDown: active.filter((r) => r.status === "down").length,
    accessRestricted: active.filter((r) => r.status === "blocked" || r.status === "limited" || r.status === "partially_blocked").length,
  };
}
