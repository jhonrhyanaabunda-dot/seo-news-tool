import Link from "next/link";
import { ArrowRight, CheckCircle2, CircleAlert, FileText, Info, TriangleAlert } from "lucide-react";
import type { ClientDashboard } from "@/lib/queries/client-dashboard";
import { scopeLabel, type Opportunity } from "@/lib/seo/opportunity";
import { ScoreHistoryChart } from "@/components/charts";
import { DetailsPrunedNotice } from "@/components/detail-retention";
import { Badge, Card, EmptyState, Notice, ScoreDelta, cn } from "@/components/ui";
import { fmtDateTime, fmtRelative } from "@/components/format";

/**
 * The dealership-facing view of a single website.
 *
 * Written for a General Manager, not an SEO analyst: it answers "how healthy is
 * my site, is it getting better, what needs attention, and what do I do next"
 * before it shows anything technical. Every number is passed in from
 * `getClientDashboard`, which reads the same stored scan values the report
 * does — nothing is computed here, so this view cannot disagree with a report
 * generated from the same scan.
 */

const PRIORITY_TONE = { CRITICAL: "critical", HIGH: "warning", MEDIUM: "warning", LOW: "neutral" } as const;
const PRIORITY_LABEL = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low" } as const;

/** Plain-language band for a score, so the number means something on its own. */
function band(score: number | null) {
  if (score === null) return { text: "Not scored", tone: "neutral" as const, blurb: "This website could not be scored in the latest check." };
  if (score >= 85) return { text: "Good", tone: "success" as const, blurb: "The website is in good health. Keep an eye on the items below." };
  if (score >= 65) return { text: "Needs improvement", tone: "warning" as const, blurb: "The website works, but several fixable problems are holding it back." };
  return { text: "Needs attention", tone: "critical" as const, blurb: "Several important problems are affecting how search engines see this website." };
}

/** One short explanation, available but not shouting. */
function Explain({ children }: { children: React.ReactNode }) {
  return (
    <details className="mt-3 text-sm">
      <summary className="inline-flex cursor-pointer items-center gap-1.5 text-brand-700 hover:underline">
        <Info aria-hidden className="h-3.5 w-3.5" /> What does this mean?
      </summary>
      <p className="mt-1.5 max-w-prose text-slate-600">{children}</p>
    </details>
  );
}


/**
 * Alert messages are written for the A3 operator: they list every affected URL,
 * separated by bullets, so the detail is recoverable from the email. On a GM's
 * dashboard that is noise, and a wall of URLs buries the one line that matters.
 * This keeps the sentence and drops the evidence, which is one click away.
 */
function summarise(message: string, dealershipName: string): string {
  const cleaned = message
    .replace(/\(https?:\/\/[^)]*\)/g, "") // the URL list behind each finding
    .replace(new RegExp(`^${dealershipName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*`, "i"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // The same finding repeats once per affected page ("The page has no H1
  // heading." five times); the count is already in the title, so one mention is
  // enough and five is just noise.
  const seen = new Set<string>();
  const unique = cleaned
    .split(/\s*•\s*|(?<=\.)\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !seen.has(part.toLowerCase()) && seen.add(part.toLowerCase()));
  const text = unique.join(" ");
  return text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text;
}

/** The dealership's own name is the page title; repeating it in every row is noise. */
function shortTitle(title: string, dealershipName: string): string {
  const prefix = `${dealershipName}: `;
  return title.startsWith(prefix) ? title.slice(prefix.length) : title;
}

export function ClientDashboardView({ data, tz, canScan, scanAction, showHeader = true }: { data: ClientDashboard; tz: string; canScan: boolean; scanAction?: React.ReactNode; /** False when the surrounding page already names the dealership. */ showHeader?: boolean }) {
  const { dealership: d, scan, activeScan, counts, pages, topIssues, trend, activity } = data;
  const b = band(scan?.score ?? null);
  const base = `/dealerships/${d.id}`;

  return (
    <div className="space-y-5">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      {showHeader && (
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{d.name}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-600">
            <a href={d.websiteUrl} target="_blank" rel="noopener noreferrer" className="break-all text-brand-700 hover:underline">
              {d.websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}
            </a>
            {scan?.completedAt && <span>Last checked {fmtRelative(scan.completedAt)}</span>}
            {activeScan && <Badge tone="accent">Checking now</Badge>}
            {!d.seoEnabled && <Badge>Monitoring paused</Badge>}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canScan && scanAction}
          <Link href={`/report/${d.id}`} className="btn">
            <FileText aria-hidden className="h-4 w-4" /> SEO report
          </Link>
        </div>
      </div>
      )}

      {!d.seoEnabled && <Notice tone="info">SEO monitoring is currently paused for this website. The results below are from the last completed check.</Notice>}
      {scan?.siteAvailable === false && <Notice tone="critical">We could not reach this website during the latest check. Until it responds, no score can be calculated.</Notice>}
      {activeScan && <Notice tone="info">A new check is running now. The results below are from the previous completed check and will update automatically when it finishes.</Notice>}

      {!scan ? (
        <EmptyState title="No results yet" description="The first check of this website is scheduled automatically and usually finishes within a few minutes. Your SEO health score will appear here as soon as it completes." />
      ) : (
        <>
          {/* ── Score + issue summary ────────────────────────────────── */}
          <div className="grid items-start gap-5 lg:grid-cols-3">
            <Card className="lg:col-span-1" title="SEO health score">
              <div className="flex items-end gap-3">
                <span className={cn("text-6xl font-semibold leading-none tracking-tight", scan.score === null ? "text-slate-400" : b.tone === "success" ? "text-emerald-700" : b.tone === "warning" ? "text-amber-700" : "text-red-700")}>
                  {scan.score ?? "—"}
                </span>
                {scan.score !== null && <span className="pb-1 text-lg text-slate-400">/ 100</span>}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone={b.tone}>{b.text}</Badge>
                {scan.scoreDelta !== null ? (
                  <span className="text-sm text-slate-600">
                    <ScoreDelta delta={scan.scoreDelta} /> {scan.scoreDelta === 0 ? "No change" : ""} from previous check
                    {scan.previousScore !== null && ` (was ${scan.previousScore})`}
                  </span>
                ) : (
                  <span className="text-sm text-slate-500">No previous score to compare against</span>
                )}
              </div>
              <p className="mt-3 text-sm text-slate-600">{b.blurb}</p>
              <Explain>
                Your SEO health score summarises how well this website follows the search-engine best practices A3 SEO Monitor checks on every page — things like page titles, descriptions, headings, links, images and technical setup. It is calculated the same way every time, so a change in the number reflects a real change on the website.
              </Explain>
            </Card>

            <Card className="lg:col-span-2" title="What needs attention">
              <div className="grid grid-cols-3 gap-3">
                <SummaryTile label="Critical" value={counts.critical} tone="critical" href={counts.critical ? `${base}?tab=issues&severity=critical` : undefined} />
                <SummaryTile label="Warnings" value={counts.warning} tone="warning" href={counts.warning ? `${base}?tab=issues&severity=warning` : undefined} />
                <SummaryTile label="Suggestions" value={counts.info} tone="neutral" href={counts.info ? `${base}?tab=issues&severity=info` : undefined} />
              </div>
              <Explain>
                Critical items can stop search engines from showing pages correctly and are worth fixing first. Warnings reduce how well pages perform. Suggestions are smaller refinements.
              </Explain>

              <h3 className="mb-2 mt-5 text-sm font-semibold text-slate-900">Pages monitored</h3>
              <PageHealthBar pages={pages} base={base} />
            </Card>
          </div>

          {/* ── What to do next ──────────────────────────────────────── */}
          <Card title="What to do next" description={topIssues.length ? "The highest-value fixes for this website, most important first." : undefined}>
            {!scan.detailsRetained && counts.critical + counts.warning > 0 ? (
              <DetailsPrunedNotice />
            ) : topIssues.length === 0 ? (
              <EmptyState title="Nothing needs attention right now" description="No SEO problems were found in the latest check of this website. We will alert you if that changes." />
            ) : (
              <ol className="divide-y divide-slate-100">
                {topIssues.map((i) => (
                  <IssueRow key={i.checkKey} issue={i} base={base} />
                ))}
              </ol>
            )}
            {topIssues.length > 0 && (
              <Link href={`${base}?tab=opportunities`} className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
                {data.opportunityCount > topIssues.length ? `View all ${data.opportunityCount} opportunities` : "View all opportunities"} <ArrowRight aria-hidden className="h-4 w-4" />
              </Link>
            )}
          </Card>

          {/* ── Trend + activity ─────────────────────────────────────── */}
          <div className="grid items-start gap-5 lg:grid-cols-2">
            <Card title="Score over time" description={trend.length > 1 ? `Last ${trend.length} completed checks` : undefined}>
              {trend.length > 1 ? (
                <ScoreHistoryChart points={trend.map((p) => ({ label: fmtDateTime(p.at, tz), score: p.score }))} />
              ) : (
                <EmptyState title="Not enough history yet" description="Your score trend will appear here once this website has been checked a few more times." />
              )}
            </Card>

            <Card title="Recent activity">
              {activity.length === 0 ? (
                <EmptyState title="You're all caught up" description="No recent alerts require your attention." />
              ) : (
                <ul className="divide-y divide-slate-100">
                  {activity.map((a) => (
                    <li key={a.id} className="flex gap-3 py-2.5 first:pt-0 last:pb-0">
                      <ActivityIcon severity={a.severity} type={a.type} />
                      <div className="min-w-0">
                        <p className="break-words text-sm font-medium text-slate-900">{shortTitle(a.title, d.name)}</p>
                        <p className="break-words text-sm text-slate-600">{summarise(a.message, d.name)}</p>
                        <p className="mt-0.5 text-xs text-slate-500">{fmtRelative(a.createdAt)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryTile({ label, value, tone, href }: { label: string; value: number; tone: "critical" | "warning" | "neutral"; href?: string }) {
  const colour = value === 0 ? "text-slate-400" : tone === "critical" ? "text-red-700" : tone === "warning" ? "text-amber-700" : "text-slate-700";
  const inner = (
    <>
      <span className={cn("block text-3xl font-semibold leading-none tracking-tight", colour)}>{value}</span>
      <span className="mt-1.5 block text-xs font-medium leading-tight text-slate-500">{label}</span>
    </>
  );
  // min-w-0 lets the grid track shrink; without it the longest label sets a
  // floor that pushes the page sideways on a small phone.
  const classes = "min-w-0 rounded-lg border border-slate-200 bg-white px-2 py-3 text-center";
  return href ? (
    <Link href={href} className={cn(classes, "transition hover:border-brand-300 hover:bg-brand-50/40")}>
      {inner}
    </Link>
  ) : (
    <div className={classes}>{inner}</div>
  );
}

/** Pages split by their worst finding. Widths are shares of the total, so the bar always fills. */
function PageHealthBar({ pages, base }: { pages: ClientDashboard["pages"]; base: string }) {
  const total = pages.total || 1;
  const segments = [
    { key: "healthy", label: "Healthy", n: pages.healthy, cls: "bg-emerald-500" },
    { key: "warning", label: "Warnings", n: pages.warning, cls: "bg-amber-500" },
    { key: "critical", label: "Critical", n: pages.critical, cls: "bg-red-600" },
    { key: "notEvaluated", label: "Not checked", n: pages.notEvaluated, cls: "bg-slate-300" },
  ].filter((s) => s.n > 0);

  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-slate-100" role="img" aria-label={`${pages.healthy} healthy, ${pages.warning} with warnings, ${pages.critical} with critical issues, ${pages.notEvaluated} not checked, of ${pages.total} pages`}>
        {segments.map((s) => (
          <div key={s.key} className={s.cls} style={{ width: `${(s.n / total) * 100}%` }} />
        ))}
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        <Legend label="Total" value={pages.total} />
        {segments.map((s) => (
          <Legend key={s.key} label={s.label} value={s.n} dot={s.cls} />
        ))}
      </dl>
      {pages.notEvaluated > 0 && (
        <p className="mt-2 text-xs text-slate-500">
          &ldquo;Not checked&rdquo; pages were blocked by the website&rsquo;s own security, not an SEO problem.{" "}
          <Link href={`${base}?tab=protected`} className="underline">
            See which
          </Link>
        </p>
      )}
    </div>
  );
}

function Legend({ label, value, dot }: { label: string; value: number; dot?: string }) {
  return (
    <div className="flex items-center gap-1.5">
      {dot && <span className={cn("h-2 w-2 shrink-0 rounded-full", dot)} />}
      <dt className="text-slate-500">{label}</dt>
      <dd className="font-medium text-slate-900">{value}</dd>
    </div>
  );
}

function IssueRow({ issue, base }: { issue: Opportunity; base: string }) {
  return (
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <Badge tone={PRIORITY_TONE[issue.priority]}>{PRIORITY_LABEL[issue.priority]}</Badge>
        <span className="break-words font-medium text-slate-900">{issue.title}</span>
        <span className="text-sm text-slate-500">
          {scopeLabel(issue)} · {issue.groupLabel}
        </span>
      </div>
      {issue.why && (
        <p className="mt-1 max-w-prose text-sm text-slate-600">
          <span className="font-medium">What we check: </span>
          {issue.why}
        </p>
      )}
      {issue.action && (
        <p className="mt-1 max-w-prose text-sm text-slate-700">
          <span className="font-medium">What to do: </span>
          {issue.action}
        </p>
      )}
      <Link href={`${base}?tab=issues&check=${encodeURIComponent(issue.checkKey)}`} className="mt-1 inline-block text-sm text-brand-700 hover:underline">
        See affected pages
      </Link>
    </li>
  );
}

function ActivityIcon({ severity, type }: { severity: string; type: string }) {
  const resolved = type === "issues_resolved" || type === "score_gain" || type === "site_recovered";
  if (resolved) return <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />;
  if (severity === "critical") return <CircleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />;
  if (severity === "warning") return <TriangleAlert aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />;
  return <Info aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />;
}
