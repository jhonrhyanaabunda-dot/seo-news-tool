import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CheckCircle2, Loader2, MinusCircle, Pencil, RefreshCw, XCircle } from "lucide-react";
import { ScanAutoRefresh } from "@/components/client/scan-auto-refresh";
import { requireUser } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { friendlyFetchError } from "@/lib/seo/messages";
import { CATEGORIES, CHECKS_BY_KEY } from "@/lib/seo/checks/config";
import { scoreBand } from "@/lib/seo/scoring";
import { scanSiteKey, siteKey } from "@/lib/seo/site-identity";
import { OUTCOME_META } from "@/lib/seo/outcome";
import { regionLabel } from "@/lib/crawler/regions";
import { getSettings } from "@/lib/settings";
import {
  getChecks,
  getDealership,
  getIssueCounts,
  getRenderedPageCount,
  getIssues,
  getLatestScans,
  getNewsCounts,
  getPages,
  getScan,
  getScanEvents,
  getScanHistory,
  getScanProgress,
  getProtectedPages,
  getReport,
  getReports,
} from "@/lib/queries/dealership";
import { getNews, parseNewsScope } from "@/lib/queries/news";
import { cancelScanAction, newsScanNowAction, scanNowAction } from "@/app/actions/dealerships";
import { Badge, Card, EmptyState, ExternalLink, Notice, PageHeader, Pagination, PriorityBadge, ScoreBadge, ScoreDelta, SeverityBadge, TableWrap, Tabs, cn } from "@/components/ui";
import { ReportView } from "@/components/report-view";
import { priorityFor } from "@/lib/seo/priority";
import { RESULT_CLASS_META, classifyPageResult } from "@/lib/seo/result-class";
import { crawlJobStatus } from "@/lib/jobs/status";
import { aiReportsConfigured } from "@/lib/reports/ai";
import { aiReportsUsedThisMonth } from "@/lib/reports/service";
import type { ReportFindings, ReportNarrative } from "@/lib/reports/types";
import { emailReportAction, generateReportAction } from "@/app/actions/reports";
import { CategoryBars, ScoreHistoryChart } from "@/components/charts";
import { SubmitButton } from "@/components/client/submit-button";
import { ArticleList } from "@/components/article-list";
import { displayUrl, fmtDate, fmtDateTime, fmtDuration, fmtRelative } from "@/components/format";

export const dynamic = "force-dynamic";

type SP = Record<string, string | undefined>;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const d = Number.isInteger(Number(id)) ? await getDealership(Number(id)) : null;
  return { title: d?.name ?? "Dealership" };
}

const NOTICES: Record<string, { tone: "success" | "info" | "warning"; text: string }> = {
  "scan-queued": { tone: "success", text: "Scan started. Results appear here as soon as it finishes (usually a few minutes)." },
  "scan-running": { tone: "info", text: "A scan is already in progress for this dealership." },
  "scan-cancelled": { tone: "info", text: "The scan was cancelled." },
  "news-queued": { tone: "success", text: "News check started. New articles will appear shortly." },
  "rate-limited": { tone: "warning", text: "Too many manual requests in the last hour. Please wait before trying again." },
  "site-changed": { tone: "success", text: "Website address updated. A scan of the new address has started; results appear here when it finishes." },
  "report-queued": { tone: "success", text: "Report requested. It is generated from the latest completed scan within a few minutes; this page shows its progress." },
  "report-running": { tone: "info", text: "A report for this dealership is already being generated." },
  "report-emailed": { tone: "success", text: "The report was emailed to the dealership's notification recipients and management recipients." },
  "report-email-failed": { tone: "warning", text: "Some report emails could not be delivered. See Admin → System for details." },
  "report-no-recipients": { tone: "warning", text: "No recipients: add notification emails to this dealership or management recipients in Settings." },
};

export default async function DealershipPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const user = await requireUser();
  const { id: idParam } = await params;
  const sp = await searchParams;
  const id = Number(idParam);
  if (!Number.isInteger(id) || id <= 0) notFound();
  const dealer = await getDealership(id);
  if (!dealer) notFound();

  const tz = env().APP_TIMEZONE;
  const tab = ["overview", "issues", "pages", "protected", "news", "reports", "history"].includes(sp.tab ?? "") ? sp.tab! : "overview";
  const [{ latest, active, lastAttempt }, newsCounts] = await Promise.all([getLatestScans(id), getNewsCounts(id)]);
  const issueCounts = latest ? await getIssueCounts(latest.id) : null;
  const base = `/dealerships/${id}`;
  const href = (next: SP) => {
    const q = new URLSearchParams(Object.entries(next).filter(([, v]) => v !== undefined && v !== "") as Array<[string, string]>);
    const s = q.toString();
    return s ? `${base}?${s}` : base;
  };

  // "Scan started" stops being true once the scan ends; the page has already refreshed to show its results.
  const notice = sp.notice && !((sp.notice === "scan-queued" || sp.notice === "scan-running") && !active) ? NOTICES[sp.notice] : null;
  const status = !dealer.isActive || !dealer.seoEnabled ? null : latest?.siteAvailable === false ? "down" : scoreBand(latest?.score);

  return (
    <>
      {sp.created && <Notice tone="success">Dealership added. The first SEO scan and news check have started automatically.</Notice>}
      {sp.updated && <Notice tone="success">Dealership details saved.</Notice>}
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <PageHeader
        breadcrumb={
          <Link href="/" className="hover:underline">
            Dashboard
          </Link>
        }
        title={dealer.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <ExternalLink href={dealer.websiteUrl}>{displayUrl(dealer.websiteUrl)}</ExternalLink>
            <span>{dealer.brand}</span>
            {(dealer.city || dealer.state) && <span>{[dealer.city, dealer.state].filter(Boolean).join(", ")}</span>}
            {dealer.dealerGroup && <span>{dealer.dealerGroup}</span>}
            {(dealer.websitePlatform ?? dealer.detectedPlatform) && <span title={dealer.websitePlatform ? "Website platform" : "Detected from the homepage"}>{dealer.websitePlatform ?? dealer.detectedPlatform}</span>}
            {dealer.lastSuccessfulScanAt && <span className="text-slate-500">Last successful crawl {fmtRelative(dealer.lastSuccessfulScanAt)}</span>}
            {!dealer.isActive && <Badge>Inactive</Badge>}
            {!dealer.seoEnabled && <Badge>SEO monitoring off</Badge>}
            {!dealer.newsEnabled && <Badge>News monitoring off</Badge>}
          </span>
        }
        actions={
          <>
            {dealer.seoEnabled && !active && (
              <form action={scanNowAction}>
                <input type="hidden" name="id" value={id} />
                <SubmitButton className="btn" pendingText="Starting…">
                  <RefreshCw aria-hidden className="h-4 w-4" /> Scan now
                </SubmitButton>
              </form>
            )}
            {user.role === "admin" && (
              <Link href={`/admin/dealerships/${id}/edit`} className="btn">
                <Pencil aria-hidden className="h-4 w-4" /> Edit
              </Link>
            )}
          </>
        }
      />

      {active && (
        <ActiveScanBanner
          scanId={active.id}
          status={active.status}
          dealershipId={id}
          isAdmin={user.role === "admin"}
          startedAt={active.startedAt ?? active.createdAt}
          updatedAt={active.updatedAt ?? active.createdAt}
          stalled={active.stalled}
          crawlPhase={active.crawlState?.phase ?? null}
        />
      )}
      {latest && scanSiteKey(latest) !== siteKey(dealer.websiteUrl) && (
        <Notice tone="warning">
          The results below are from the previous website address (<strong>{scanSiteKey(latest)}</strong>), not {siteKey(dealer.websiteUrl)}.{" "}
          {active ? "A scan of the current address is in progress." : "Click “Scan now” to scan the current address."}
        </Notice>
      )}
      {latest?.outcome === "blocked" && (
        <Notice tone="warning">
          <strong>⚠️ Scan Blocked</strong> — This dealership website restricted automated access. SEO results for inaccessible pages were not evaluated.
          {latest.siteChecks?.auditMode === "remote" && (
            <>
              {" "}A limited homepage check from an alternative source (<strong>Google PageSpeed Insights</strong>) is shown instead; nothing else was checked.
            </>
          )}{" "}
          <strong>Requires review:</strong> ask the website provider to allow-list the A3SEOMonitor crawler.
        </Notice>
      )}
      {latest?.outcome === "partially_blocked" && (
        <Notice tone="warning">
          <strong>Partially blocked</strong> — The website restricted automated access to {latest.pagesBlocked + latest.pagesNotEvaluated} page(s). Those pages were not evaluated and are <strong>not</strong> counted as SEO problems.{" "}
          <Link href={href({ tab: "pages", filter: "not_evaluated" })} className="underline">
            See which pages
          </Link>
        </Notice>
      )}
      {!active && lastAttempt?.status === "failed" && (
        <Notice tone="warning">
          The most recent scan ({fmtDateTime(lastAttempt.createdAt, tz)}) could not be completed: {lastAttempt.errorMessage ?? "Unknown error"}.
          {latest ? " Results below are from the last successful scan." : ""}
        </Notice>
      )}

      <Tabs
        active={tab}
        tabs={[
          { key: "overview", label: "Overview", href: href({}) },
          { key: "issues", label: "SEO issues", href: href({ tab: "issues" }), count: issueCounts ? issueCounts.bySeverity.critical + issueCounts.bySeverity.warning + issueCounts.bySeverity.info : null },
          { key: "pages", label: "Pages", href: href({ tab: "pages" }), count: latest?.pagesScanned ?? null },
          { key: "protected", label: "Protected pages", href: href({ tab: "protected" }), count: latest ? latest.pagesBlocked + latest.pagesNotEvaluated || null : null },
          { key: "news", label: "News", href: href({ tab: "news" }), count: newsCounts.new || null },
          { key: "reports", label: "Reports", href: href({ tab: "reports" }) },
          { key: "history", label: "Crawl history", href: href({ tab: "history" }) },
        ]}
      />

      {tab === "overview" && <Overview latest={latest} status={status} tz={tz} issueCounts={issueCounts} newsCounts={newsCounts} href={href} />}
      {tab === "issues" && (latest ? <IssuesTab scanId={latest.id} sp={sp} href={href} tz={tz} counts={issueCounts!} notEvaluated={latest.pagesBlocked + latest.pagesNotEvaluated} /> : <NoScanYet />)}
      {tab === "pages" && (latest ? <PagesTab scanId={latest.id} sp={sp} href={href} /> : <NoScanYet />)}
      {tab === "news" && <NewsTab dealerId={id} sp={sp} href={href} tz={tz} counts={newsCounts} newsEnabled={dealer.newsEnabled} />}
      {tab === "protected" && (latest ? <ProtectedTab scanId={latest.id} jobStatus={crawlJobStatus(latest)} tz={tz} /> : <NoScanYet />)}
      {tab === "reports" && <ReportsTab dealerId={id} sp={sp} href={href} tz={tz} isAdmin={user.role === "admin"} hasScan={Boolean(latest)} />}
      {tab === "history" && <HistoryTab dealerId={id} sp={sp} href={href} tz={tz} currentSite={siteKey(dealer.websiteUrl)} />}
    </>
  );
}

function NoScanYet() {
  return <EmptyState title="No completed scan yet" description="Results will appear here after the first SEO scan finishes. New dealerships are scanned automatically within a few minutes." />;
}

/**
 * A scan only advances while something drains the job queue (the worker, or a
 * cron tick). If nothing does, the row sits in an active status untouched until
 * maintenance fails it six hours later — so when `stalled` is set (no write for
 * five minutes) say so, rather than implying progress that is not happening.
 */
async function ActiveScanBanner({
  scanId,
  status,
  dealershipId,
  isAdmin,
  startedAt,
  updatedAt,
  stalled,
  crawlPhase,
}: {
  scanId: number;
  status: string;
  crawlPhase: string | null;
  dealershipId: number;
  isAdmin: boolean;
  startedAt: Date;
  updatedAt: Date;
  stalled: boolean;
}) {
  const progress = await getScanProgress(scanId);
  const phase =
    status === "queued"
      ? "waiting for the crawler to start"
      : status === "finalizing"
        ? "calculating results"
        : crawlPhase === "links"
          ? `checking links (${progress.done} pages crawled)`
          : progress.total === 0
            ? "loading the homepage"
            : `${progress.done} of ${progress.total} pages checked`;

  return (
    <div
      role={stalled ? "alert" : "status"}
      className={cn(
        "mb-4 flex flex-wrap items-center justify-between gap-3 rounded-md px-4 py-3 text-sm ring-1 ring-inset",
        stalled ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-brand-50 text-brand-700 ring-brand-100",
      )}
    >
      {stalled ? (
        <span>
          <strong>Scan stalled</strong> — {phase}, but nothing has made progress since {fmtRelative(updatedAt)}. The job queue is not being processed; check that the scan worker or the cron schedule is running. It will be marked failed automatically six hours after it started.
        </span>
      ) : (
        <span>
          <Loader2 aria-hidden className="mr-1.5 inline h-4 w-4 animate-spin align-[-3px]" />
          <strong>Scan in progress</strong> — {phase} · started {fmtRelative(startedAt)}. This updates automatically; results appear when it finishes.
        </span>
      )}
      <ScanAutoRefresh />
      {isAdmin && (
        <form action={cancelScanAction}>
          <input type="hidden" name="id" value={dealershipId} />
          <input type="hidden" name="scanId" value={scanId} />
          <SubmitButton className="btn btn-sm" confirm="Cancel this scan?">
            Cancel scan
          </SubmitButton>
        </form>
      )}
    </div>
  );
}

/* ───────────────────────────── Overview ───────────────────────────── */

async function Overview({
  latest,
  status,
  tz,
  issueCounts,
  newsCounts,
  href,
}: {
  latest: Awaited<ReturnType<typeof getLatestScans>>["latest"];
  status: string | null;
  tz: string;
  issueCounts: Awaited<ReturnType<typeof getIssueCounts>> | null;
  newsCounts: Record<string, number>;
  href: (sp: SP) => string;
}) {
  if (!latest) return <NoScanYet />;
  const checks = await getChecks(latest.id);
  const renderedCount = await getRenderedPageCount(latest.id);
  const failing = checks.filter((c) => c.status === "fail" || c.status === "warn").slice(0, 8);
  const passed = checks.filter((c) => c.status === "pass");
  const sc = latest.siteChecks;
  const cs = latest.changeSummary;
  const blocked = Boolean(sc?.crawlBlocked);
  const remote = sc?.auditMode === "remote";
  const cats = Object.entries(latest.categoryScores ?? {}).map(([key, v]) => ({ key, label: CATEGORIES[key as keyof typeof CATEGORIES]?.label ?? key, score: v.score }));
  const statusLabel: Record<string, { text: string; tone: "success" | "warning" | "critical" | "neutral" }> = {
    good: { text: "Good", tone: "success" },
    fair: { text: "Needs improvement", tone: "warning" },
    poor: { text: "Poor", tone: "critical" },
    down: { text: "Website unavailable", tone: "critical" },
    unknown: { text: "Not scored", tone: "neutral" },
  };
  const st = statusLabel[status ?? "unknown"] ?? statusLabel.unknown;

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <Card className="lg:col-span-1" title="SEO score">
        <div className="flex items-end justify-between">
          <ScoreBadge score={latest.score} size="lg" />
          <Badge tone={st.tone}>{st.text}</Badge>
        </div>
        {cs?.scoreDelta !== null && cs?.scoreDelta !== undefined && (
          <p className="mt-1 text-sm text-slate-600">
            <ScoreDelta delta={cs.scoreDelta} /> {cs.scoreDelta === 0 ? "No change" : ""} since previous scan ({cs.previousScore})
          </p>
        )}
        {latest.outcome && (
          <p className="mt-2 flex items-center gap-2 text-sm text-slate-600">
            Scan status: <Badge tone={OUTCOME_META[latest.outcome].tone}>{OUTCOME_META[latest.outcome].label}</Badge>
          </p>
        )}
        {latest.errorMessage && <p className="mt-2 text-sm text-amber-800">{latest.errorMessage}</p>}
        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
          <div>
            <dt className="text-slate-500">Last scan</dt>
            <dd className="font-medium">{fmtDateTime(latest.completedAt, tz)}</dd>
          </div>
          <div>
            <dt className="text-slate-500">Pages scanned</dt>
            <dd className="font-medium">{latest.pagesScanned}</dd>
          </div>
          <Link href={href({ tab: "issues", severity: "critical" })} className="rounded-md bg-red-50 p-2 hover:bg-red-100">
            <dt className="text-red-800">Critical</dt>
            <dd className="text-xl font-semibold text-red-800">{issueCounts?.bySeverity.critical ?? 0}</dd>
          </Link>
          <Link href={href({ tab: "issues", severity: "warning" })} className="rounded-md bg-amber-50 p-2 hover:bg-amber-100">
            <dt className="text-amber-800">Warnings</dt>
            <dd className="text-xl font-semibold text-amber-800">{issueCounts?.bySeverity.warning ?? 0}</dd>
          </Link>
          <div className="rounded-md bg-emerald-50 p-2">
            <dt className="text-emerald-800">Passed checks</dt>
            <dd className="text-xl font-semibold text-emerald-800">{blocked && !remote ? "—" : latest.passedCount}</dd>
          </div>
          <Link href={href({ tab: "news" })} className="rounded-md bg-brand-50 p-2 hover:bg-brand-100">
            <dt className="text-brand-700">New news</dt>
            <dd className="text-xl font-semibold text-brand-700">{newsCounts.new}</dd>
          </Link>
        </dl>
        {cs && cs.previousScanId && (
          <p className="mt-4 text-sm text-slate-600">
            Since the previous scan: <strong className="text-red-700">{cs.newCriticalCount} new critical</strong>, <strong className="text-amber-700">{cs.newWarningCount} new warnings</strong>,{" "}
            <strong className="text-emerald-700">{cs.resolvedCount} resolved</strong>.{" "}
            <Link href={href({ tab: "history", scan: String(latest.id) })} className="text-brand-700 underline">
              See changes
            </Link>
          </p>
        )}
      </Card>

      <Card className="lg:col-span-2" title="Score by category" description="Deterministic, rule-based scoring. The same site under the same conditions always gets the same score.">
        {blocked ? (
          <p className="text-sm text-slate-600">
            {remote
              ? "Not scored. Only a limited homepage check through Google was possible, so a full-site score cannot be calculated. The problems Google could verify are listed below."
              : "Not scored. The scanner could not read this website’s pages, so category scores cannot be calculated. Results will appear after a scan that is not blocked."}
          </p>
        ) : cats.length ? (
          <CategoryBars categories={cats} />
        ) : (
          <p className="text-sm text-slate-500">Category scores are not available for this scan.</p>
        )}
      </Card>

      <Card className="lg:col-span-2" title="Top problems" actions={<Link href={href({ tab: "issues" })} className="text-sm text-brand-700 hover:underline">All issues →</Link>}>
        {blocked && !remote ? (
          <p className="text-sm text-amber-800">Nothing could be checked: the scanner was blocked, so this is not a clean result.</p>
        ) : failing.length === 0 ? (
          <p className="text-sm text-emerald-700">{remote ? "No problems found on the homepage in Google’s limited check. The rest of the site was not checked." : "No problems found in the latest scan."}</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {failing.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <SeverityBadge severity={CHECKS_BY_KEY[c.checkKey]?.severity ?? "warning"} />
                    <Link href={href({ tab: "issues", check: c.checkKey })} className="font-medium text-slate-900 hover:underline">
                      {CHECKS_BY_KEY[c.checkKey]?.problem ?? c.label}
                    </Link>
                  </div>
                  <p className="mt-0.5 text-sm text-slate-600">{CHECKS_BY_KEY[c.checkKey]?.recommendation}</p>
                </div>
                <span className="shrink-0 text-sm text-slate-500">
                  {c.failCount + c.warnCount} affected
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Site health">
        {sc ? (
          <ul className="space-y-2 text-sm">
            {sc.blockedReason === "firewall" ? (
              <Fact unknown label="Website access" detail={remote ? "Blocked for direct scans · homepage checked via Google" : `Blocked by site security${sc.homepageStatus ? ` (HTTP ${sc.homepageStatus})` : ""}`} />
            ) : (
              <Fact ok={latest.siteAvailable !== false} label="Website reachable" detail={sc.homepageStatus ? `HTTP ${sc.homepageStatus}` : undefined} />
            )}
            <Fact ok={sc.homepageHttps} unknown={blocked && !sc.homepageHttps} label="Served over HTTPS" detail={blocked && !sc.homepageHttps ? "Not checked" : undefined} />
            {sc.robotsTxt.blocked ? (
              <Fact unknown label="robots.txt" detail="Not checked (blocked)" />
            ) : (
              <Fact ok={sc.robotsTxt.found && !sc.robotsTxt.blocksAll && !sc.robotsTxt.blocksGooglebot} label="robots.txt" detail={!sc.robotsTxt.found ? "Not found" : sc.robotsTxt.blocksAll || sc.robotsTxt.blocksGooglebot ? "Blocks search engines" : "OK"} />
            )}
            {blocked ? (
              <>
                <Fact unknown label="XML sitemap" detail="Not checked" />
                <Fact unknown label="Links, duplicates & response time" detail="Not checked" />
              </>
            ) : (
              <>
                <Fact ok={sc.sitemap.found && sc.sitemap.urlCount > 0} label="XML sitemap" detail={sc.sitemap.found ? `${sc.sitemap.urlCount} URLs` : "Not found"} />
                <Fact ok={sc.brokenInternalLinks === 0} label="Broken internal links" detail={`${sc.brokenInternalLinks} of ${sc.linksChecked} links checked`} />
                <Fact ok={sc.brokenExternalLinks === 0} label="Broken external links" detail={String(sc.brokenExternalLinks)} />
                <Fact ok={sc.duplicateTitles === 0} label="Duplicate titles" detail={String(sc.duplicateTitles)} />
                <Fact ok={sc.duplicateDescriptions === 0} label="Duplicate meta descriptions" detail={String(sc.duplicateDescriptions)} />
                <Fact ok={(sc.avgResponseMs ?? 0) < 3000} label="Average response time" detail={sc.avgResponseMs ? `${(sc.avgResponseMs / 1000).toFixed(2)}s` : "—"} />
              </>
            )}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No site checks recorded.</p>
        )}
      </Card>

      {sc && sc.importantPages.length > 0 && (
        <Card title="Key dealership pages" className="lg:col-span-2">
          <ul className="grid gap-2 text-sm sm:grid-cols-2">
            {sc.importantPages.map((p) => (
              <li key={p.key} className="flex items-center gap-2">
                {p.found ? <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-emerald-600" /> : <XCircle aria-hidden className="h-4 w-4 shrink-0 text-red-600" />}
                <span className="sr-only">{p.found ? "Found:" : "Missing:"}</span>
                {p.url ? <ExternalLink href={p.url}>{p.label}</ExternalLink> : <span className="text-slate-700">{p.label} — not found</span>}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="Access & coverage" description="What the crawler could and could not evaluate. Pages that could not be accessed are never reported as SEO problems.">
        <dl className="grid grid-cols-2 gap-3 text-sm">
          <Metric label="Pages evaluated" value={latest.pagesScanned} />
          <Metric label="Not evaluated (access restricted)" value={latest.pagesBlocked + latest.pagesNotEvaluated} />
          <Metric
            label="Data source"
            value={sc?.dataSource === "google_pagespeed" ? "Alternative: Google PageSpeed Insights" : sc?.dataSource === "none" ? "None (blocked)" : "A3 crawler (direct)"}
          />
          <Metric label="Crawled from" value={sc?.crawledFrom ? `${regionLabel(sc.crawledFrom.region)}` : latest.region ? regionLabel(latest.region) : "—"} />
          {renderedCount > 0 && <Metric label="Read with a browser" value={renderedCount} />}
        </dl>
        {renderedCount > 0 && (
          <p className="mt-3 text-xs text-slate-500">
            {renderedCount} page(s) were refused for a plain request and were read with a real browser (Chromium), which runs the JavaScript this site requires. The crawler identified itself as
            A3SEOMonitor throughout and robots.txt was respected.
          </p>
        )}
        {sc?.blockedUrls && sc.blockedUrls.length > 0 && (
          <div className="mt-3">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Restricted URLs</div>
            <ul className="mt-1 space-y-1 text-xs">
              {sc.blockedUrls.slice(0, 8).map((b) => (
                <li key={b.url}>
                  <ExternalLink href={b.url}>{displayUrl(b.url)}</ExternalLink>{" "}
                  <span className="text-slate-500">
                    — {b.status ? `HTTP ${b.status}` : "no response"} · {b.reason}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Performance (Google Lighthouse)" description="Lab data from PageSpeed Insights, mobile. Shown for context; not part of the score because it varies between runs.">
        {sc?.pagespeed && sc.pagespeed.performance !== null ? (
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <Metric label="Performance" value={`${sc.pagespeed.performance}/100`} />
            <Metric label="Largest Contentful Paint" value={sc.pagespeed.lcpMs !== null ? `${(sc.pagespeed.lcpMs / 1000).toFixed(1)}s` : "—"} />
            <Metric label="Cumulative Layout Shift" value={sc.pagespeed.cls ?? "—"} />
            <Metric label="Total Blocking Time" value={sc.pagespeed.tbtMs !== null ? `${sc.pagespeed.tbtMs}ms` : "—"} />
          </dl>
        ) : (
          <p className="text-sm text-slate-500">{sc?.pagespeed?.error ? `Not available: ${sc.pagespeed.error}.` : "Not configured. Add a PAGESPEED_API_KEY to enable Lighthouse metrics."} Server response times are always measured by the crawler.</p>
        )}
      </Card>

      {(!blocked || remote) && <Card title={`Passed checks (${passed.length})`} className="lg:col-span-3">
        <ul className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {passed.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-slate-700">
              <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0 text-emerald-600" />
              {c.label}
            </li>
          ))}
        </ul>
      </Card>}
    </div>
  );
}

function Fact({ ok = false, unknown = false, label, detail }: { ok?: boolean; unknown?: boolean; label: string; detail?: string }) {
  return (
    <li className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2">
        {unknown ? (
          <MinusCircle aria-hidden className="h-4 w-4 text-slate-400" />
        ) : ok ? (
          <CheckCircle2 aria-hidden className="h-4 w-4 text-emerald-600" />
        ) : (
          <XCircle aria-hidden className="h-4 w-4 text-red-600" />
        )}
        <span className="sr-only">{unknown ? "Not checked:" : ok ? "Pass:" : "Problem:"}</span>
        {label}
      </span>
      {detail && <span className={cn("text-right", unknown ? "text-amber-700" : ok ? "text-slate-500" : "font-medium text-red-700")}>{detail}</span>}
    </li>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-slate-50 p-2">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

/* ───────────────────────────── Issues ─────────────────────────────── */

async function IssuesTab({
  scanId,
  sp,
  href,
  tz,
  counts,
  notEvaluated,
}: {
  scanId: number;
  sp: SP;
  href: (sp: SP) => string;
  tz: string;
  counts: Awaited<ReturnType<typeof getIssueCounts>>;
  notEvaluated: number;
}) {
  const page = Math.max(1, Number(sp.p) || 1);
  const pageSize = 50;
  const { rows, total } = await getIssues(scanId, {
    severity: sp.severity,
    category: sp.category,
    pageId: sp.page ? Number(sp.page) : undefined,
    onlyNew: sp.new === "1",
    page,
    pageSize,
  });
  const filtered = sp.check ? rows.filter((r) => r.checkKey === sp.check) : rows;
  const keep = { tab: "issues", severity: sp.severity, category: sp.category, page: sp.page, new: sp.new, check: sp.check };
  const chip = (label: string, next: SP, active: boolean) => (
    <Link href={href({ ...keep, ...next, p: undefined })} aria-current={active ? "true" : undefined} className={cn("rounded-full px-3 py-1 text-sm ring-1 ring-inset", active ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}>
      {label}
    </Link>
  );
  return (
    <div>
      {notEvaluated > 0 && (
        <Notice tone="warning">
          {notEvaluated} page(s) could not be evaluated because the website restricted automated access. They are not included below — these are access restrictions, not SEO problems.{" "}
          <Link href={href({ tab: "pages", filter: "not_evaluated" })} className="underline">
            See pages
          </Link>
        </Notice>
      )}
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by severity">
        {chip(`All (${counts.bySeverity.critical + counts.bySeverity.warning + counts.bySeverity.info})`, { severity: undefined }, !sp.severity)}
        {chip(`Critical (${counts.bySeverity.critical})`, { severity: "critical" }, sp.severity === "critical")}
        {chip(`Warnings (${counts.bySeverity.warning})`, { severity: "warning" }, sp.severity === "warning")}
        {chip(`Notices (${counts.bySeverity.info})`, { severity: "info" }, sp.severity === "info")}
        <span className="mx-1 hidden w-px bg-slate-200 sm:block" />
        {chip("New since last scan", { new: sp.new === "1" ? undefined : "1" }, sp.new === "1")}
      </div>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter by category">
        {chip("All categories", { category: undefined }, !sp.category)}
        {Object.entries(CATEGORIES).map(([k, v]) => (counts.byCategory[k] ? <span key={k}>{chip(`${v.label} (${counts.byCategory[k]})`, { category: k }, sp.category === k)}</span> : null))}
      </div>
      {(sp.page || sp.check) && (
        <Notice tone="info">
          Filtered to {sp.page ? "a single page" : CHECKS_BY_KEY[sp.check!]?.problem ?? sp.check}.{" "}
          <Link className="underline" href={href({ tab: "issues" })}>
            Clear filter
          </Link>
        </Notice>
      )}
      {filtered.length === 0 ? (
        <EmptyState title="No issues match these filters" description="Try a different severity or category." />
      ) : (
        <TableWrap caption="SEO issues found in the latest scan">
          <thead>
            <tr>
              <th scope="col">Priority</th>
              <th scope="col">Issue</th>
              <th scope="col">Page</th>
              <th scope="col">Recommended action</th>
              <th scope="col">Detected</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((i) => {
              const target = typeof i.details?.target === "string" ? i.details.target : null;
              return (
                <tr key={i.id}>
                  <td>
                    <div className="flex flex-col items-start gap-1">
                      <PriorityBadge priority={priorityFor(i.checkKey, i.severity)} />
                      {i.isNew && <Badge tone="accent">New</Badge>}
                    </div>
                  </td>
                  <td className="max-w-sm">
                    <div className="font-medium text-slate-900">{CHECKS_BY_KEY[i.checkKey]?.problem ?? i.checkKey}</div>
                    <div className="text-slate-600">{i.message}</div>
                    {target && (
                      <div className="mt-1 text-xs">
                        Link target: <ExternalLink href={target}>{displayUrl(target)}</ExternalLink>
                      </div>
                    )}
                  </td>
                  <td className="max-w-xs">
                    <ExternalLink href={i.url}>{displayUrl(i.url)}</ExternalLink>
                    {i.pageId && (
                      <div className="mt-1">
                        <Link href={href({ tab: "issues", page: String(i.pageId) })} className="text-xs text-slate-500 hover:underline">
                          All issues on this page
                        </Link>
                      </div>
                    )}
                  </td>
                  <td className="max-w-sm text-slate-600">{i.recommendation}</td>
                  <td className="whitespace-nowrap text-slate-500">{fmtDate(i.firstDetectedAt, tz)}</td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      <Pagination page={page} totalPages={Math.ceil(total / pageSize)} hrefFor={(p) => href({ ...keep, p: String(p) })} />
    </div>
  );
}

/* ───────────────────────────── Pages ──────────────────────────────── */

function indexability(p: Awaited<ReturnType<typeof getPages>>["rows"][number]): { label: string; tone: "success" | "warning" | "critical" | "neutral" } {
  if (p.errorCode === "BLOCKED") return { label: "Access restricted", tone: "warning" };
  if (p.errorCode === "NOT_EVALUATED") return { label: "Not evaluated", tone: "neutral" };
  if (p.status === "skipped") return { label: p.errorCode === "ROBOTS_BLOCKED" ? "Blocked by robots.txt" : p.errorCode === "DUPLICATE" ? "Duplicate (redirect)" : "Skipped", tone: "neutral" };
  if (p.status === "failed" || (p.httpStatus ?? 0) >= 400) return { label: "Error", tone: "critical" };
  if ((p.httpStatus ?? 0) >= 300) return { label: "Redirect", tone: "neutral" };
  if (p.indexable === false) return { label: "Noindex", tone: "warning" };
  if (p.canonical) {
    try {
      const a = new URL(p.canonical);
      const b = new URL(p.finalUrl ?? p.url);
      if (a.hostname.replace(/^www\./, "") !== b.hostname.replace(/^www\./, "") || a.pathname.replace(/\/$/, "") !== b.pathname.replace(/\/$/, "")) return { label: "Canonicalised", tone: "warning" };
    } catch {
      /* ignore */
    }
  }
  return { label: "Indexable", tone: "success" };
}

async function PagesTab({ scanId, sp, href }: { scanId: number; sp: SP; href: (sp: SP) => string }) {
  const page = Math.max(1, Number(sp.p) || 1);
  const pageSize = 50;
  const filter = sp.filter ?? "default";
  const { rows, total } = await getPages(scanId, { filter, page, pageSize });
  const chip = (label: string, f: string) => (
    <Link href={href({ tab: "pages", filter: f === "default" ? undefined : f })} aria-current={filter === f ? "true" : undefined} className={cn("rounded-full px-3 py-1 text-sm ring-1 ring-inset", filter === f ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50")}>
      {label}
    </Link>
  );
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filter pages">
        {chip("Crawled pages", "default")}
        {chip("With issues", "issues")}
        {chip("Errors", "errors")}
        {chip("Noindex", "noindex")}
        {chip("Protected / not evaluated", "not_evaluated")}
        {chip("Everything (incl. skipped)", "all")}
      </div>
      {rows.length === 0 ? (
        <EmptyState title="No pages match this filter" />
      ) : (
        <TableWrap caption="Pages analysed in the latest scan">
          <thead>
            <tr>
              <th scope="col">URL</th>
              <th scope="col">Status</th>
              <th scope="col">Title</th>
              <th scope="col">Meta description</th>
              <th scope="col">H1</th>
              <th scope="col">Canonical</th>
              <th scope="col">Indexability</th>
              <th scope="col">Issues</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((p) => {
              const idx = indexability(p);
              const err = p.status === "failed" || (p.httpStatus ?? 0) >= 400;
              return (
                <tr key={p.id}>
                  <td className="max-w-[16rem]">
                    <ExternalLink href={p.finalUrl ?? p.url}>{displayUrl(p.finalUrl ?? p.url)}</ExternalLink>
                    <div className="mt-0.5 flex flex-wrap gap-1">
                      {p.isImportant && <Badge tone="accent">Key page</Badge>}
                      {p.pageType && p.pageType !== "other" && <Badge>{p.pageType.replace(/_/g, " ")}</Badge>}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">
                    {(() => {
                      const cls = p.resultClass ?? classifyPageResult(p);
                      return cls ? (
                        <div className="mb-0.5" title={RESULT_CLASS_META[cls].description}>
                          <Badge tone={RESULT_CLASS_META[cls].tone}>{RESULT_CLASS_META[cls].label}</Badge>
                        </div>
                      ) : null;
                    })()}
                    {p.httpStatus ? <span className={cn("font-mono text-xs", err ? "text-red-700" : "text-slate-700")}>{p.httpStatus}</span> : <span className="text-xs text-red-700">—</span>}
                    {err && <div className="max-w-[10rem] text-xs text-red-700">{friendlyFetchError(p.errorCode, p.httpStatus)}</div>}
                    {p.responseTimeMs !== null && !err && <div className="text-xs text-slate-500">{(p.responseTimeMs / 1000).toFixed(2)}s</div>}
                  </td>
                  <td className="max-w-[14rem]">{p.title ?? <span className="text-red-700">Missing</span>}</td>
                  <td className="max-w-[16rem] text-slate-600">{p.metaDescription ? <span className="line-clamp-3">{p.metaDescription}</span> : <span className="text-amber-700">Missing</span>}</td>
                  <td className="max-w-[12rem]">{p.h1 && p.h1.length ? p.h1[0] + (p.h1.length > 1 ? ` (+${p.h1.length - 1})` : "") : <span className="text-amber-700">Missing</span>}</td>
                  <td className="max-w-[12rem] break-all text-xs">{p.canonical ? displayUrl(p.canonical) : <span className="text-amber-700">Missing</span>}</td>
                  <td>
                    <Badge tone={idx.tone}>{idx.label}</Badge>
                  </td>
                  <td className="text-right">
                    {p.issueCount > 0 ? (
                      <Link href={href({ tab: "issues", page: String(p.id) })} className="font-medium text-brand-700 hover:underline">
                        {p.issueCount}
                      </Link>
                    ) : (
                      <span className="text-slate-400">0</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
      )}
      <Pagination page={page} totalPages={Math.ceil(total / pageSize)} hrefFor={(p) => href({ tab: "pages", filter: sp.filter, p: String(p) })} />
    </div>
  );
}

/* ─────────────────────────── Protected pages ─────────────────────────── */

async function ProtectedTab({ scanId, jobStatus, tz }: { scanId: number; jobStatus: string; tz: string }) {
  const rows = await getProtectedPages(scanId);
  if (rows.length === 0) {
    return <EmptyState title="No protected pages" description="Every page requested in the latest scan could be analyzed." />;
  }
  const browserTried = rows.filter((r) => r.fetchMethod === "browser").length;
  return (
    <div>
      <Notice tone="warning">
        <strong>Protected / Unable to analyze</strong> — The website&apos;s security (for example Cloudflare) served a challenge or refused the monitor for {rows.length} page{rows.length === 1 ? "" : "s"} in the latest scan ({jobStatus}). These pages were not analyzed and are <strong>not</strong> counted as SEO problems. The monitor never tries to get around website security. To include them, ask the website provider to allow-list the <code>A3SEOMonitor</code> crawler.
      </Notice>
      <TableWrap caption="Pages the website's security prevented the monitor from analyzing">
        <thead>
          <tr>
            <th scope="col">URL</th>
            <th scope="col">Result</th>
            <th scope="col">HTTP</th>
            <th scope="col">Reason</th>
            <th scope="col">Checked</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const cls = p.resultClass ?? classifyPageResult(p) ?? "NOT_EVALUATED";
            return (
              <tr key={p.id}>
                <td className="max-w-[20rem]">
                  <ExternalLink href={p.finalUrl ?? p.url}>{displayUrl(p.finalUrl ?? p.url)}</ExternalLink>
                </td>
                <td title={RESULT_CLASS_META[cls].description}>
                  <Badge tone="warning">{RESULT_CLASS_META[cls].label}</Badge>
                </td>
                <td className="font-mono text-xs">{p.httpStatus ?? "—"}</td>
                <td className="max-w-[22rem] text-xs text-slate-600">
                  {p.errorMessage ?? RESULT_CLASS_META[cls].description}
                  {p.fetchMethod === "browser" && <div className="text-slate-400">A real browser was also refused.</div>}
                </td>
                <td className="whitespace-nowrap text-xs text-slate-500">{p.fetchedAt ? fmtDateTime(p.fetchedAt, tz) : "Not requested"}</td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
      {browserTried > 0 && <p className="mt-2 text-xs text-slate-500">{browserTried} of these were retried once with a real browser, which was also refused.</p>}
    </div>
  );
}

/* ─────────────────────────────── Reports ─────────────────────────────── */

async function ReportsTab({ dealerId, sp, href, tz, isAdmin, hasScan }: { dealerId: number; sp: SP; href: (sp: SP) => string; tz: string; isAdmin: boolean; hasScan: boolean }) {
  const [list, used] = await Promise.all([getReports(dealerId), aiReportsUsedThisMonth()]);
  const selectedId = sp.report ? Number(sp.report) : list.find((r) => r.status === "completed")?.id;
  const selected = selectedId ? await getReport(dealerId, selectedId) : null;
  const limit = env().AI_REPORTS_MONTHLY_LIMIT;
  const pending = list.some((r) => r.status === "queued" || r.status === "generating");
  const statusBadge = (s: string) => (s === "completed" ? <Badge tone="success">Ready</Badge> : s === "failed" ? <Badge tone="critical">Failed</Badge> : <Badge tone="accent">{s === "generating" ? "Generating…" : "Queued"}</Badge>);

  return (
    <div className="grid gap-5 lg:grid-cols-[16rem_1fr]">
      <aside className="space-y-3">
        <form action={generateReportAction}>
          <input type="hidden" name="id" value={dealerId} />
          <SubmitButton className="btn-primary w-full" pendingText="Requesting…">
            Generate report
          </SubmitButton>
        </form>
        {!hasScan && <p className="text-xs text-amber-700">A completed scan is needed before a report can be generated.</p>}
        <p className="text-xs text-slate-500">
          {aiReportsConfigured() ? `AI summaries this month: ${used} of ${limit}. Reports with unchanged findings are reused at no cost.` : "AI summaries are not configured; reports are composed directly from the findings."}
        </p>
        {pending && <p className="text-xs text-slate-500">A report is being prepared — refresh in a minute.</p>}
        <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm">
          {list.length === 0 && <li className="p-3 text-slate-500">No reports yet.</li>}
          {list.map((r) => (
            <li key={r.id}>
              <Link href={href({ tab: "reports", report: String(r.id) })} aria-current={selected?.id === r.id ? "true" : undefined} className={cn("block p-3 hover:bg-slate-50", selected?.id === r.id && "bg-brand-50")}>
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-900">{fmtDate(r.completedAt ?? r.createdAt, tz)}</span>
                  {statusBadge(r.status)}
                </div>
                {r.status === "completed" && <div className="text-xs text-slate-500">{r.generator === "ai" ? "AI-assisted" : "Standard"}</div>}
              </Link>
            </li>
          ))}
        </ul>
      </aside>
      <div className="min-w-0">
        {!selected ? (
          <EmptyState title="No report selected" description="Generate a report to get an executive summary, prioritized issues, protected pages and news for this dealership." />
        ) : selected.status !== "completed" || !selected.findings || !selected.narrative ? (
          selected.status === "failed" ? (
            <Notice tone="warning">This report could not be generated: {selected.error ?? "Unknown error"}</Notice>
          ) : (
            <EmptyState title="Preparing report…" description="The report is built from the latest completed scan. Refresh this page in a minute." />
          )
        ) : (
          <>
            {isAdmin && (
              <form action={emailReportAction} className="mb-3 flex justify-end">
                <input type="hidden" name="reportId" value={selected.id} />
                <SubmitButton className="btn btn-sm" pendingText="Sending…" confirm="Email this report to the dealership's notification recipients and management recipients?">
                  Email report
                </SubmitButton>
              </form>
            )}
            <ReportView findings={selected.findings as ReportFindings} narrative={selected.narrative as ReportNarrative} generator={selected.generator} generatorNote={selected.generatorNote} completedAt={selected.completedAt} tz={tz} />
          </>
        )}
      </div>
    </div>
  );
}

/* ───────────────────────────── News ───────────────────────────────── */

async function NewsTab({ dealerId, sp, href, tz, counts, newsEnabled }: { dealerId: number; sp: SP; href: (sp: SP) => string; tz: string; counts: Record<string, number>; newsEnabled: boolean }) {
  const status = sp.status ?? "new";
  const scope = parseNewsScope(sp.scope) === "brand" ? "brand" : "dealership";
  const page = Math.max(1, Number(sp.p) || 1);
  const { rows, total } = await getNews({ dealershipId: dealerId, status: status === "all" ? undefined : status, scope, page, pageSize: 25 });
  const settings = await getSettings();
  const pill = (active: boolean) => cn("rounded-full px-3 py-1 text-sm ring-1 ring-inset", active ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-700 ring-slate-300 hover:bg-slate-50");
  const chip = (label: string, s: string) => (
    <Link href={href({ tab: "news", scope, status: s })} aria-current={status === s ? "true" : undefined} className={pill(status === s)}>
      {label}
    </Link>
  );
  // Status counts describe this store's own news, so they are only shown on that view.
  const n = (k: string) => (scope === "dealership" ? ` (${counts[k]})` : "");
  return (
    <div>
      <nav aria-label="News source" className="mb-3 flex flex-wrap gap-2 border-b border-slate-200 pb-3">
        <Link href={href({ tab: "news" })} aria-current={scope === "dealership" ? "page" : undefined} className={pill(scope === "dealership")}>
          This dealership
        </Link>
        <Link href={href({ tab: "news", scope: "brand" })} aria-current={scope === "brand" ? "page" : undefined} className={pill(scope === "brand")}>
          Brand &amp; industry{counts.brandNew ? ` (${counts.brandNew} new)` : ""}
        </Link>
      </nav>
      {scope === "brand" && (
        <p className="mb-3 text-sm text-slate-600">
          Manufacturer news such as recalls and new models, matched on the brand name alone. It is shown for context and is not counted as this dealership&apos;s news. Mark an article <strong>Relevant</strong> to move it into this dealership&apos;s news.
        </p>
      )}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter news by status">
          {chip(`New${n("new")}`, "new")}
          {chip(`Relevant${n("relevant")}`, "relevant")}
          {chip(`Reviewed${n("reviewed")}`, "reviewed")}
          {chip(`Not relevant${n("not_relevant")}`, "not_relevant")}
          {chip("All", "all")}
        </div>
        {newsEnabled && (
          <form action={newsScanNowAction}>
            <input type="hidden" name="id" value={dealerId} />
            <SubmitButton className="btn btn-sm" pendingText="Starting…">
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Check news now
            </SubmitButton>
          </form>
        )}
      </div>
      {!newsEnabled && <Notice tone="info">News monitoring is turned off for this dealership.</Notice>}
      {rows.length === 0 ? (
        <EmptyState
          title="No articles here"
          description={
            scope === "dealership"
              ? "Articles appear when news sources mention this dealership by name, its dealer group, a custom keyword, or dealership news in its city. Add the names the store trades under as custom keywords."
              : "Manufacturer recalls, new models and announcements for this brand appear here."
          }
        />
      ) : (
        <ArticleList rows={rows} tz={tz} minScore={settings.newsAlertMinScore} />
      )}
      <Pagination page={page} totalPages={Math.ceil(total / 25)} hrefFor={(p) => href({ tab: "news", scope, status, p: String(p) })} />
    </div>
  );
}

/* ───────────────────────────── History ────────────────────────────── */

async function HistoryTab({ dealerId, sp, href, tz, currentSite }: { dealerId: number; sp: SP; href: (sp: SP) => string; tz: string; currentSite: string | null }) {
  const history = await getScanHistory(dealerId);
  const siteById = new Map(history.map((h) => [h.id, siteKey(h.websiteUrl)]));
  const completed = history.filter((h) => h.status === "completed" && (!currentSite || !siteKey(h.websiteUrl) || siteKey(h.websiteUrl) === currentSite)).reverse();
  const points = completed.map((h) => ({ label: fmtDateTime(h.completedAt, tz), score: h.score, down: h.siteAvailable === false }));
  const selectedId = sp.scan ? Number(sp.scan) : null;
  const selected = selectedId ? await getScan(dealerId, selectedId) : null;
  const events = selected ? await getScanEvents(selected.id) : [];

  return (
    <div className="space-y-5">
      <Card title="SEO score history">
        <ScoreHistoryChart points={points} />
      </Card>

      {selected && (
        <Card
          title={`Scan on ${fmtDateTime(selected.completedAt ?? selected.createdAt, tz)}`}
          actions={
            <Link href={href({ tab: "history" })} className="text-sm text-brand-700 hover:underline">
              Close
            </Link>
          }
        >
          {selected.changeSummary?.previousScanId ? (
            <div className="grid gap-5 md:grid-cols-2">
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">New issues ({(selected.changeSummary.newCriticalCount ?? 0) + (selected.changeSummary.newWarningCount ?? 0)} critical/warning)</h3>
                <IssueChangeList items={selected.changeSummary.newIssues} empty="No new issues." />
              </div>
              <div>
                <h3 className="mb-2 text-sm font-semibold text-slate-900">Resolved issues ({selected.changeSummary.resolvedCount})</h3>
                <IssueChangeList items={selected.changeSummary.resolvedIssues} empty="No issues were resolved." />
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-600">This was the first comparable scan, so it established the baseline for change detection.</p>
          )}
          {events.length > 0 && (
            <details className="mt-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-700">Scan log ({events.length} events)</summary>
              <ol className="mt-2 space-y-1 text-xs">
                {events.map((e) => (
                  <li key={e.id} className={cn(e.level === "error" ? "text-red-700" : e.level === "warn" ? "text-amber-700" : "text-slate-600")}>
                    <span className="font-mono">{fmtDateTime(e.createdAt, tz)}</span> — {e.message}
                  </li>
                ))}
              </ol>
            </details>
          )}
        </Card>
      )}

      <TableWrap caption="Previous scans">
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Type</th>
            <th scope="col">Result</th>
            <th scope="col" className="!text-right">
              Score
            </th>
            <th scope="col" className="!text-right">
              Critical
            </th>
            <th scope="col" className="!text-right">
              Warnings
            </th>
            <th scope="col" className="!text-right">
              Pages
            </th>
            <th scope="col">Changes</th>
            {/* Wall-clock from first page fetch to finish. A scan paused waiting for a
                free worker inflates this, so it is not a measure of crawl effort. */}
            <th scope="col" title="Wall-clock time from scan start to finish, including any time spent waiting for a worker">
              Elapsed
            </th>
          </tr>
        </thead>
        <tbody>
          {history.length === 0 && (
            <tr>
              <td colSpan={9} className="py-6 text-center text-slate-500">
                No scans yet.
              </td>
            </tr>
          )}
          {history.map((h) => (
            <tr key={h.id} className={cn(selectedId === h.id && "bg-brand-50")}>
              <td className="whitespace-nowrap">
                {h.status === "completed" ? (
                  <Link href={href({ tab: "history", scan: String(h.id) })} className="text-brand-700 hover:underline">
                    {fmtDateTime(h.completedAt ?? h.createdAt, tz)}
                  </Link>
                ) : (
                  fmtDateTime(h.createdAt, tz)
                )}
              </td>
              <td className="capitalize text-slate-600">
                {h.trigger}
                {siteKey(h.websiteUrl) && siteKey(h.websiteUrl) !== currentSite && <div className="text-xs normal-case text-amber-700">{siteKey(h.websiteUrl)}</div>}
              </td>
              <td>
                {h.status === "completed" ? (
                  h.siteAvailable === false ? (
                    <Badge tone="critical">Site down</Badge>
                  ) : h.outcome && h.outcome !== "completed" ? (
                    <span title={h.errorMessage ?? OUTCOME_META[h.outcome].description}>
                      <Badge tone={OUTCOME_META[h.outcome].tone}>
                        {OUTCOME_META[h.outcome].label}
                        {h.auditMode === "remote" ? " · limited data" : ""}
                      </Badge>
                    </span>
                  ) : (
                    <Badge tone="success">Completed</Badge>
                  )
                ) : h.status === "failed" ? (
                  <span title={h.errorMessage ?? undefined}>
                    <Badge tone="warning">Failed</Badge>
                  </span>
                ) : h.status === "cancelled" ? (
                  <Badge>Cancelled</Badge>
                ) : (
                  <Badge tone="accent">In progress</Badge>
                )}
              </td>
              <td className="text-right">
                <ScoreBadge score={h.score} /> <ScoreDelta delta={h.changeSummary?.scoreDelta} />
              </td>
              <td className="text-right tabular-nums">{h.status === "completed" ? h.criticalCount : "—"}</td>
              <td className="text-right tabular-nums">{h.status === "completed" ? h.warningCount : "—"}</td>
              <td className="text-right tabular-nums">{h.status === "completed" ? h.pagesScanned : "—"}</td>
              <td className="whitespace-nowrap text-xs">
                {h.changeSummary?.previousScanId && siteById.get(h.changeSummary.previousScanId) && siteById.get(h.changeSummary.previousScanId) !== siteKey(h.websiteUrl) ? (
                  <span className="text-amber-700">New website address</span>
                ) : h.blockedReason ? (
                  <span className="text-slate-500">Not checked</span>
                ) : h.changeSummary?.previousScanId ? (
                  <>
                    <span className="text-red-700">+{h.changeSummary.newCriticalCount + h.changeSummary.newWarningCount} new</span> · <span className="text-emerald-700">{h.changeSummary.resolvedCount} resolved</span>
                  </>
                ) : h.status === "completed" ? (
                  <span className="text-slate-500">Baseline</span>
                ) : (
                  "—"
                )}
              </td>
              <td className="whitespace-nowrap text-slate-500">{fmtDuration(h.startedAt, h.completedAt)}</td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
    </div>
  );
}

function IssueChangeList({ items, empty }: { items: Array<{ fingerprint: string; checkKey: string; severity: string; url: string; message: string }>; empty: string }) {
  if (!items.length) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="space-y-2 text-sm">
      {items.map((i) => (
        <li key={i.fingerprint} className="rounded-md border border-slate-100 p-2">
          <div className="flex items-center gap-2">
            <SeverityBadge severity={i.severity} />
            <span className="font-medium">{CHECKS_BY_KEY[i.checkKey]?.problem ?? i.checkKey}</span>
          </div>
          <div className="mt-1 text-slate-600">{i.message}</div>
          <ExternalLink href={i.url} className="mt-0.5 text-xs">
            {displayUrl(i.url)}
          </ExternalLink>
        </li>
      ))}
    </ul>
  );
}
