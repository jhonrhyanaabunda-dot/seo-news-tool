import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { getDashboardSummary, getDealerRows } from "@/lib/queries/dashboard";
import { getSettings } from "@/lib/settings";
import { EmptyState, MetaStat, Notice, PageHeader, StatCard } from "@/components/ui";
import { DealershipTable, type DealerTableRow } from "@/components/client/dealership-table";
import { fmtDateTime, fmtRelative } from "@/components/format";

export const metadata: Metadata = { title: "Dashboard" };
export const dynamic = "force-dynamic";

function scheduleLabel(hours: number): string {
  if (hours % 24 !== 0) return `Every ${hours}h`;
  const days = hours / 24;
  return days === 1 ? "Every day" : `Every ${days} days`;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ error?: string; q?: string; status?: string; sort?: string; dir?: string }> }) {
  const user = await requireUser();
  const { error, q, status, sort, dir } = await searchParams;
  const tz = env().APP_TIMEZONE;
  const [rows, settings] = await Promise.all([getDealerRows(), getSettings()]);
  const summary = await getDashboardSummary(rows);
  const now = summary.generatedAt;

  const tableRows: DealerTableRow[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    brand: r.brand,
    location: [r.city, r.state].filter(Boolean).join(", "),
    score: r.score,
    scoreDelta: r.scoreDelta,
    critical: r.critical,
    warnings: r.warnings,
    newNews: r.newNews,
    lastScanLabel: r.lastScanAt ? fmtRelative(r.lastScanAt, now) : "Never",
    lastScanSort: r.lastScanAt ? new Date(r.lastScanAt).getTime() : 0,
    status: r.status,
    statusDetail: r.statusDetail,
    pagesAnalyzed: r.pagesAnalyzed,
    pagesProtected: r.pagesProtected,
  }));

  return (
    <>
      {error === "forbidden" && <Notice tone="warning">That area is only available to administrators.</Notice>}
      {settings.schedulerPaused && <Notice tone="warning">Scheduled scanning is paused. Scans only run when requested manually. {user.role === "admin" && <Link href="/admin/settings" className="underline">Change in Settings</Link>}</Notice>}
      <PageHeader
        title="Dashboard"
        description={`SEO & news monitoring across ${summary.totalDealerships} dealership${summary.totalDealerships === 1 ? "" : "s"}.`}
        actions={
          user.role === "admin" && (
            <Link href="/admin/dealerships/new" className="btn-primary">
              <Plus aria-hidden className="h-4 w-4" /> Add dealership
            </Link>
          )
        }
      />

      {/* The four numbers worth acting on. Everything else is context, below. */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard
          label="Average SEO score"
          value={summary.averageScore ?? "—"}
          tone={summary.averageScore === null ? "neutral" : summary.averageScore >= 85 ? "success" : summary.averageScore >= 65 ? "warning" : "critical"}
          hint={`Across ${summary.scanned} scanned site${summary.scanned === 1 ? "" : "s"}`}
        />
        <StatCard label="Critical SEO issues" value={summary.critical} tone={summary.critical ? "critical" : "success"} hint={summary.sitesDown ? `${summary.sitesDown} website(s) down` : "Across latest scans"} />
        <StatCard label="Warnings" value={summary.warnings} tone={summary.warnings ? "warning" : "success"} hint="Across latest scans" />
        <StatCard label="New news articles" value={summary.newNews} tone={summary.newNews ? "accent" : "neutral"} hint="Awaiting review" href="/news?status=new" />
      </div>

      <div className="mb-6 mt-3 grid grid-cols-2 gap-y-1 rounded-lg border border-slate-200 bg-white px-1 py-1.5 shadow-sm sm:grid-cols-3 lg:grid-cols-6">
        <MetaStat label="Coverage" value={`${summary.scanned}/${summary.totalDealerships}`} hint="Dealerships scanned" />
        <MetaStat label="Last scan" value={summary.lastScan ? fmtRelative(summary.lastScan, now) : "Never"} hint={summary.lastScan ? fmtDateTime(summary.lastScan, tz) : undefined} />
        <MetaStat
          label="Next scan"
          value={settings.schedulerPaused ? "Paused" : summary.nextScan ? (summary.nextScan.getTime() <= now ? "Due now" : fmtRelative(summary.nextScan, now)) : "—"}
          tone={settings.schedulerPaused ? "warning" : "neutral"}
          hint={summary.nextScan && !settings.schedulerPaused ? fmtDateTime(summary.nextScan, tz) : undefined}
        />
        <MetaStat label="Schedule" value={scheduleLabel(settings.seoIntervalHours)} hint={`News every ${settings.newsIntervalHours}h`} />
        <MetaStat label="Scan failures" value={summary.scanFailures} tone={summary.scanFailures ? "warning" : "success"} hint="Last 7 days" href={user.role === "admin" ? "/admin/system" : undefined} />
        <MetaStat label="Access restricted" value={summary.accessRestricted} tone={summary.accessRestricted ? "warning" : "success"} hint="Not SEO issues" />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No dealerships yet"
          description="Add your first dealership to start automatic SEO and news monitoring. New dealerships are scanned right away and then on the configured schedule."
          action={
            user.role === "admin" && (
              <Link href="/admin/dealerships/new" className="btn-primary">
                Add dealership
              </Link>
            )
          }
        />
      ) : (
        <DealershipTable rows={tableRows} initial={{ q, status, sort, dir }} />
      )}
    </>
  );
}
