import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { countByPriority, scopeLabel, type Opportunity } from "@/lib/seo/opportunity";
import { DetailsPrunedNotice } from "@/components/detail-retention";
import { EmptyState, cn } from "@/components/ui";
import { IssueWorkflowEditor } from "@/components/issue-workflow";
import { fmtDateTime } from "@/components/format";

/**
 * The action centre: every open opportunity from one scan, most important
 * first, in the scanner's own words.
 *
 * Nothing on this page is computed here. Titles, explanations, recommendations,
 * priorities and groups all arrive from `getOpportunities`, which reads the
 * check catalogue — so this view can be swapped for a printed one without the
 * facts changing.
 */

/**
 * Priority is carried by the word, the shape and the position in the list, not
 * by colour alone: a reader who cannot distinguish red from amber still gets
 * the ordering and the label.
 */
const PRIORITY: Record<Opportunity["priority"], { label: string; dot: string; chip: string }> = {
  CRITICAL: { label: "Critical", dot: "bg-red-600", chip: "bg-red-50 text-red-800 ring-red-200" },
  HIGH: { label: "High", dot: "bg-orange-500", chip: "bg-orange-50 text-orange-900 ring-orange-200" },
  MEDIUM: { label: "Medium", dot: "bg-amber-500", chip: "bg-amber-50 text-amber-900 ring-amber-200" },
  LOW: { label: "Low", dot: "bg-slate-400", chip: "bg-slate-100 text-slate-700 ring-slate-300" },
};

/** Priorities worth leading with; the rest are listed below under their own heading. */
const TOP_PRIORITIES: Array<Opportunity["priority"]> = ["CRITICAL", "HIGH"];

export function OpportunitiesView({
  opportunities,
  scanCompletedAt,
  detailsRetained,
  storedIssueTotal,
  tz,
  base,
  ignored = [],
  workflowEditor,
}: {
  opportunities: Opportunity[];
  scanCompletedAt: Date | null;
  detailsRetained: boolean;
  /** Critical + warning counters stored on the scan; they outlive the detail rows. */
  storedIssueTotal: number;
  tz: string;
  base: string;
  /** Opportunities whose every finding staff marked "ignored": listed apart, still counted in the score. */
  ignored?: Opportunity[];
  /** Present for admins: lets them set the status of all of a check's findings at once. */
  workflowEditor?: { dealershipId: number; assignees: Array<{ id: number; name: string }> };
}) {
  const ignoredSection = ignored.length > 0 && <IgnoredSection list={ignored} base={base} editor={workflowEditor} />;
  // Counts with no detail behind them mean the records were pruned, not that
  // the website is clean — the same disclosure rule as the issues tab.
  if (opportunities.length === 0 && !detailsRetained && storedIssueTotal > 0) {
    return (
      <div className="space-y-5">
        <Header count={null} scanCompletedAt={scanCompletedAt} tz={tz} />
        <DetailsPrunedNotice />
      </div>
    );
  }

  if (opportunities.length === 0) {
    return (
      <div className="space-y-5">
        <Header count={0} scanCompletedAt={scanCompletedAt} tz={tz} />
        <EmptyState
          title="You're in good shape"
          description="No SEO opportunities need attention based on the latest check of this website. We check regularly and will flag anything new here."
        />
        {ignoredSection}
      </div>
    );
  }

  const counts = countByPriority(opportunities);
  const top = opportunities.filter((o) => TOP_PRIORITIES.includes(o.priority));
  const rest = opportunities.filter((o) => !TOP_PRIORITIES.includes(o.priority));

  return (
    <div className="space-y-5">
      <Header count={opportunities.length} scanCompletedAt={scanCompletedAt} tz={tz} />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(Object.keys(PRIORITY) as Array<Opportunity["priority"]>).map((p) => (
          <div key={p} className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-3">
            <div className="flex items-center gap-1.5">
              <span className={cn("h-2 w-2 shrink-0 rounded-full", PRIORITY[p].dot)} />
              <span className="truncate text-xs font-medium text-slate-500">{PRIORITY[p].label}</span>
            </div>
            <span className={cn("mt-1 block text-2xl font-semibold leading-none tracking-tight", counts[p] === 0 ? "text-slate-400" : "text-slate-900")}>{counts[p]}</span>
          </div>
        ))}
      </div>

      {top.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-900">
            Address first
            <span className="ml-2 font-normal text-slate-500">
              {top.length} {top.length === 1 ? "opportunity" : "opportunities"}
            </span>
          </h2>
          <ul className="space-y-3">
            {top.map((o) => (
              <OpportunityCard key={o.checkKey} o={o} base={base} editor={workflowEditor} />
            ))}
          </ul>
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-slate-900">
            {top.length > 0 ? "Also worth doing" : "Opportunities"}
            <span className="ml-2 font-normal text-slate-500">
              {rest.length} {rest.length === 1 ? "opportunity" : "opportunities"}
            </span>
          </h2>
          <ul className="space-y-3">
            {rest.map((o) => (
              <OpportunityCard key={o.checkKey} o={o} base={base} editor={workflowEditor} />
            ))}
          </ul>
        </section>
      )}
      {ignoredSection}
    </div>
  );
}

/** Workflow progress on an opportunity's findings, in words ("2 fixed · 1 in progress"). */
function workflowSummary(o: Opportunity): string | null {
  const w = o.workflow ?? {};
  const parts = [w.in_progress ? `${w.in_progress} in progress` : null, w.fixed ? `${w.fixed} marked fixed` : null, w.ignored ? `${w.ignored} ignored` : null].filter(Boolean);
  return parts.length ? `${parts.join(" · ")} of ${o.findings} ${o.findings === 1 ? "finding" : "findings"}` : null;
}

function IgnoredSection({ list, base, editor }: { list: Opportunity[]; base: string; editor?: { dealershipId: number; assignees: Array<{ id: number; name: string }> } }) {
  return (
    <section className="opacity-75">
      <h2 className="mb-1 text-sm font-semibold text-slate-700">
        Ignored
        <span className="ml-2 font-normal text-slate-500">
          {list.length} {list.length === 1 ? "opportunity" : "opportunities"}
        </span>
      </h2>
      <p className="mb-2 text-xs text-slate-500">
        Every finding of these was marked “ignored” by A3, so they are left out of the lists above. They are still counted in the SEO score, which is calculated from what each scan finds.
      </p>
      <ul className="space-y-2">
        {list.map((o) => (
          <li key={o.checkKey} className="rounded-lg border border-dashed border-slate-300 bg-white px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">{o.title}</span>
              <span className="text-xs text-slate-500">
                {PRIORITY[o.priority].label} priority · {scopeLabel(o)}
              </span>
            </div>
            {editor && <IssueWorkflowEditor dealershipId={editor.dealershipId} checkKey={o.checkKey} state={null} assignees={editor.assignees} back={`${base}?tab=opportunities`} summary="Change status of all its findings" />}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Header({ count, scanCompletedAt, tz }: { count: number | null; scanCompletedAt: Date | null; tz: string }) {
  return (
    <div>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">SEO opportunities</h1>
      <p className="mt-1 text-sm text-slate-600">
        Recommended actions based on your latest website check
        {scanCompletedAt ? ` on ${fmtDateTime(scanCompletedAt, tz)}` : ""}.
        {count !== null && ` ${count} open ${count === 1 ? "opportunity" : "opportunities"}.`}
      </p>
    </div>
  );
}

/**
 * One opportunity. The summary is always visible; the fuller explanation sits
 * behind a disclosure so a list of fifteen stays scannable instead of becoming
 * a wall of scanner prose.
 */
function OpportunityCard({ o, base, editor }: { o: Opportunity; base: string; editor?: { dealershipId: number; assignees: Array<{ id: number; name: string }> } }) {
  const p = PRIORITY[o.priority];
  const progress = workflowSummary(o);
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={cn("inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset", p.chip)}>
          <span className={cn("h-1.5 w-1.5 rounded-full", p.dot)} aria-hidden />
          {p.label} priority
        </span>
        <span className="text-xs text-slate-500">{o.groupLabel}</span>
      </div>

      <h3 className="mt-2 break-words text-[15px] font-semibold text-slate-900">{o.title}</h3>

      {/* The catalogue's `description` states the standard a page should meet,
          not the consequence of missing it. Labelling it as the standard keeps
          the wording authoritative and stops the card reading as a
          contradiction ("Broken internal links — links resolve without
          errors"). */}
      <dl className="mt-1.5 space-y-1 text-sm">
        {o.why && (
          <div>
            <dt className="inline font-medium text-slate-700">What we check: </dt>
            <dd className="inline break-words text-slate-600">{o.why}</dd>
          </div>
        )}
        <div>
          <dt className="inline font-medium text-slate-700">Scope: </dt>
          <dd className="inline text-slate-600">{scopeLabel(o)}</dd>
        </div>
        {progress && (
          <div>
            <dt className="inline font-medium text-slate-700">Status: </dt>
            <dd className="inline text-slate-600">{progress}</dd>
          </div>
        )}
      </dl>
      {editor && <IssueWorkflowEditor dealershipId={editor.dealershipId} checkKey={o.checkKey} state={null} assignees={editor.assignees} back={`${base}?tab=opportunities`} summary="Set status for all its findings" />}

      <details className="group mt-2.5">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded text-sm font-medium text-brand-700 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600">
          <span className="transition group-open:hidden">Recommended action</span>
          <span className="hidden transition group-open:inline">Hide action</span>
          <ArrowRight aria-hidden className="h-3.5 w-3.5 transition group-open:rotate-90" />
        </summary>
        <div className="mt-2 rounded-md bg-slate-50 p-3">
          <p className="max-w-prose break-words text-sm text-slate-700">{o.action}</p>
          {o.scope === "page" && (o.affectedPages ?? 0) > 0 && (
            <Link href={`${base}?tab=issues&check=${encodeURIComponent(o.checkKey)}`} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
              View affected pages <ArrowRight aria-hidden className="h-3.5 w-3.5" />
            </Link>
          )}
        </div>
      </details>
    </li>
  );
}
