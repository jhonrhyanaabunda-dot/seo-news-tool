import { PRIORITY_ORDER, REPORT_GROUPS, type ReportGroup } from "@/lib/seo/priority";
import { RESULT_CLASS_META } from "@/lib/seo/result-class";
import type { FindingArticle, FindingIssue, ReportFindings, ReportNarrative } from "@/lib/reports/types";
import { topicLabel } from "@/lib/news/relevance";
import { Badge, Card, ExternalLink, PriorityBadge, ScoreBadge } from "@/components/ui";
import { displayUrl, fmtDateTime } from "@/components/format";

/**
 * A report as the reader sees it. Sections are rendered from the stored
 * findings (crawler/database facts); the narrative contributes only the summary
 * wording and the prioritised action text, already validated against them.
 */
export function ReportView({ findings: f, narrative: n, generator, generatorNote, completedAt, tz }: { findings: ReportFindings; narrative: ReportNarrative; generator: string | null; generatorNote: string | null; completedAt: Date | null; tz: string }) {
  const critical = f.issues.filter((i) => i.priority === "CRITICAL");
  const byGroup = new Map<ReportGroup, FindingIssue[]>();
  for (const i of f.issues) byGroup.set(i.group, [...(byGroup.get(i.group) ?? []), i]);
  const highlight = new Map(n.newsHighlights.map((h) => [h.articleId, h.note]));
  const statusTone = f.scan.status === "COMPLETED" ? "success" : f.scan.status === "PARTIAL" ? "warning" : "neutral";

  return (
    <article className="space-y-5">
      <Card title="Executive summary" description={`${generator === "ai" ? "AI-assisted summary of the crawler findings" : "Summary composed from the crawler findings"} · ${completedAt ? fmtDateTime(completedAt, tz) : ""}`}>
        <div className="flex flex-wrap items-start gap-6">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-slate-500">Overall health</div>
            <ScoreBadge score={f.scan.score} size="lg" />
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-slate-500">Scan status</dt>
              <dd>
                <Badge tone={statusTone}>{f.scan.status}</Badge>
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Pages analyzed</dt>
              <dd className="font-semibold tabular-nums">{f.scan.pagesAnalyzed}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Protected pages</dt>
              <dd className="font-semibold tabular-nums">{f.scan.pagesProtected}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Issues</dt>
              <dd className="flex flex-wrap gap-1 text-xs">
                <PriorityBadge priority="CRITICAL" /> {f.counts.critical} <PriorityBadge priority="HIGH" /> {f.counts.high} <PriorityBadge priority="MEDIUM" /> {f.counts.medium} <PriorityBadge priority="LOW" /> {f.counts.low}
              </dd>
            </div>
          </dl>
        </div>
        <p className="mt-4 text-sm leading-relaxed text-slate-800">{n.executiveSummary}</p>
        {f.scan.limitedHomepageCheckOnly && <p className="mt-2 text-sm text-amber-800">Only a limited homepage check was possible for this website.</p>}
        {generatorNote && <p className="mt-2 text-xs text-slate-500">{generatorNote}</p>}
      </Card>

      <Card title="Critical issues" description="Requires immediate attention">
        {critical.length === 0 ? <p className="text-sm text-slate-600">No critical issues were found in the analyzed pages.</p> : <IssueList issues={critical} />}
      </Card>

      <Card title="SEO issues" description="Grouped by area; priorities are calculated from the SEO rules, not by AI">
        {f.issues.length === 0 ? (
          <p className="text-sm text-slate-600">No SEO issues were found in the analyzed pages.</p>
        ) : (
          <div className="space-y-5">
            {(Object.keys(REPORT_GROUPS) as ReportGroup[])
              .filter((g) => byGroup.has(g))
              .map((g) => (
                <section key={g}>
                  <h3 className="mb-2 text-sm font-semibold text-slate-900">
                    {REPORT_GROUPS[g]} <span className="font-normal text-slate-500">({byGroup.get(g)!.length})</span>
                  </h3>
                  <IssueList issues={byGroup.get(g)!.sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority])} />
                </section>
              ))}
            {f.performance && (
              <p className="text-xs text-slate-500">
                Mobile performance (Google PageSpeed, not scored): {f.performance.mobileScore ?? "—"}/100{f.performance.lcpMs !== null && ` · LCP ${(f.performance.lcpMs / 1000).toFixed(1)}s`}
                {f.performance.cls !== null && ` · CLS ${f.performance.cls}`}
              </p>
            )}
          </div>
        )}
      </Card>

      <Card title="Protected pages" description="Could not be analyzed because the website restricted automated access. Not SEO issues.">
        {f.protectedPages.total === 0 ? (
          <p className="text-sm text-slate-600">Every requested page could be analyzed.</p>
        ) : (
          <>
            {n.protectedPagesNote && <p className="mb-3 text-sm text-slate-700">{n.protectedPagesNote}</p>}
            <ul className="divide-y divide-slate-100 text-sm">
              {f.protectedPages.items.map((p) => (
                <li key={p.url} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <ExternalLink href={p.url}>{displayUrl(p.url)}</ExternalLink>
                  <Badge tone="warning">{RESULT_CLASS_META[p.resultClass].label}</Badge>
                </li>
              ))}
            </ul>
            {f.protectedPages.total > f.protectedPages.items.length && <p className="mt-2 text-xs text-slate-500">…and {f.protectedPages.total - f.protectedPages.items.length} more.</p>}
          </>
        )}
      </Card>

      <Card title="News monitoring" description={`Last ${f.news.periodDays} days · ${f.news.newCount} new · ${f.news.relevantCount} relevant`}>
        {n.newsSummary && <p className="mb-3 text-sm text-slate-700">{n.newsSummary}</p>}
        <NewsGroup title="Dealership news" items={f.news.dealership} highlight={highlight} empty="No news about this dealership in this period." />
        <NewsGroup title="Manufacturer news" items={f.news.manufacturer} highlight={highlight} empty="No manufacturer news in this period." />
        <NewsGroup title="Notable industry news" items={f.news.industry} highlight={highlight} empty="No notable industry news in this period." />
      </Card>

      <Card title="Recommended actions" description="Ordered by priority">
        {n.recommendedActions.length === 0 ? (
          <p className="text-sm text-slate-600">No actions needed based on this scan.</p>
        ) : (
          <ol className="space-y-3">
            {n.recommendedActions.map((a, idx) => (
              <li key={a.checkKey} className="flex gap-3">
                <span className="mt-0.5 w-5 shrink-0 text-right text-sm font-semibold tabular-nums text-slate-400">{idx + 1}.</span>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <PriorityBadge priority={a.priority} />
                    <span className="text-sm font-semibold text-slate-900">{a.title}</span>
                    <span className="text-xs text-slate-500">{countLabel(a.affectedPages, a.unit)}</span>
                  </div>
                  <p className="mt-1 text-sm text-slate-800">{a.action}</p>
                  <p className="mt-0.5 text-xs text-slate-500">{a.rationale}</p>
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </article>
  );
}

/** Older reports predate `unit`; they counted pages. */
function countLabel(n: number, unit: "page" | "link" | undefined): string {
  const word = unit === "link" ? "broken link" : "page";
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function IssueList({ issues }: { issues: FindingIssue[] }) {
  return (
    <ul className="space-y-2">
      {issues.map((i) => (
        <li key={i.checkKey} className="rounded-md border border-slate-100 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <PriorityBadge priority={i.priority} />
            <span className="text-sm font-medium text-slate-900">{i.title}</span>
            <span className="text-xs text-slate-500">{countLabel(i.affectedPages, i.unit)}</span>
          </div>
          <p className="mt-1 text-xs text-slate-600">{i.example}</p>
          <p className="mt-1 text-xs text-slate-700">{i.recommendation}</p>
          {i.sampleUrls.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
              {i.sampleUrls.map((u) => (
                <ExternalLink key={u} href={u}>
                  {displayUrl(u)}
                </ExternalLink>
              ))}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function NewsGroup({ title, items, highlight, empty }: { title: string; items: FindingArticle[]; highlight: Map<number, string>; empty: string }) {
  return (
    <section className="mb-4 last:mb-0">
      <h3 className="mb-1.5 text-sm font-semibold text-slate-900">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="space-y-1.5 text-sm">
          {items.map((a) => (
            <li key={a.id}>
              <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="font-medium text-slate-900 hover:text-brand-700 hover:underline">
                {a.title}
              </a>
              <span className="text-xs text-slate-500">
                {" "}
                · {a.source ?? "Unknown source"}
                {a.publishedAt && ` · ${a.publishedAt}`}
                {a.topics.length > 0 && ` · ${a.topics.map(topicLabel).join(", ")}`}
              </span>
              {highlight.get(a.id) && <div className="text-xs text-slate-600">{highlight.get(a.id)}</div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
