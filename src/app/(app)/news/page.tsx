import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/guards";
import { accessibleDealershipIds } from "@/lib/auth/tenant";
import { env } from "@/lib/env";
import { getDealershipOptions, getNews, getNewsByDealership, NEWS_STATUSES, parseNewsScope } from "@/lib/queries/news";
import { getSettings } from "@/lib/settings";
import { markAllReviewedAction } from "@/app/actions/news";
import { Badge, EmptyState, PageHeader, Pagination } from "@/components/ui";
import { SubmitButton } from "@/components/client/submit-button";
import { ArticleList } from "@/components/article-list";

export const metadata: Metadata = { title: "News" };
export const dynamic = "force-dynamic";

const LABELS: Record<string, string> = { new: "New", relevant: "Relevant", reviewed: "Reviewed", not_relevant: "Not relevant", all: "All" };
/** Newest articles shown per dealership in the combined view; "View all" opens that dealership's full list. */
const PER_DEALERSHIP = 10;
const PAGE_SIZE = 30;

export default async function NewsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const status = sp.status && (sp.status === "all" || (NEWS_STATUSES as readonly string[]).includes(sp.status)) ? sp.status : "new";
  const dealershipId = sp.dealership ? Number(sp.dealership) || undefined : undefined;
  const minScore = sp.min ? Number(sp.min) || undefined : undefined;
  const scope = parseNewsScope(sp.scope);
  const page = Math.max(1, Number(sp.p) || 1);
  // `?dealership=` is a filter, never a grant: it intersects with `allowed`, so
  // asking for someone else's dealership returns an empty list.
  const allowed = await accessibleDealershipIds(user);
  const filters = { status: status === "all" ? undefined : status, minScore, scope, allowed };
  const tz = env().APP_TIMEZONE;

  const [sections, single, dealers, settings] = await Promise.all([
    getNewsByDealership({ ...filters, dealershipId, perDealership: dealershipId ? 0 : PER_DEALERSHIP }),
    dealershipId ? getNews({ ...filters, dealershipId, page, pageSize: PAGE_SIZE }) : null,
    getDealershipOptions(allowed),
    getSettings(),
  ]);
  const qs = (next: { dealership?: number; p?: number }) => {
    const q = new URLSearchParams();
    q.set("status", status);
    if (scope !== "dealership") q.set("scope", scope);
    if (next.dealership) q.set("dealership", String(next.dealership));
    if (minScore) q.set("min", String(minScore));
    if (next.p && next.p > 1) q.set("p", String(next.p));
    return `/news?${q}`;
  };
  const grandTotal = sections.reduce((n, s) => n + s.total, 0);

  return (
    <>
      <PageHeader
        title="News monitoring"
        description="News about your dealerships, grouped by store and newest first: mentions of the store, its dealer group, custom keywords and local dealership news. Brand recalls and new models are kept separately under Brand & industry."
      />
      <form method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div>
          <label htmlFor="scope" className="label">
            Show
          </label>
          <select id="scope" name="scope" defaultValue={scope} className="input">
            <option value="dealership">Dealership news</option>
            <option value="brand">Brand &amp; industry</option>
            <option value="all">Both</option>
          </select>
        </div>
        <div>
          <label htmlFor="status" className="label">
            Status
          </label>
          <select id="status" name="status" defaultValue={status} className="input">
            {["new", "relevant", "reviewed", "not_relevant", "all"].map((s) => (
              <option key={s} value={s}>
                {LABELS[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="dealership" className="label">
            Dealership
          </label>
          <select id="dealership" name="dealership" defaultValue={dealershipId ?? ""} className="input">
            <option value="">All dealerships</option>
            {dealers.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="min" className="label">
            Relevance
          </label>
          <select id="min" name="min" defaultValue={minScore ?? ""} className="input">
            <option value="">Any</option>
            <option value={settings.newsAlertMinScore}>High ({settings.newsAlertMinScore}+)</option>
            <option value="25">Medium (25+)</option>
          </select>
        </div>
        <button type="submit" className="btn-primary">
          Apply
        </button>
      </form>

      {!dealershipId && sections.length > 1 && (
        <nav aria-label="Jump to a dealership" className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500">Jump to:</span>
          {sections.map(({ dealer, total }) => (
            <a key={dealer.id} href={`#dealer-${dealer.id}`} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-700 shadow-sm hover:border-brand-300 hover:text-brand-700">
              {dealer.name}
              <span className="rounded-full bg-slate-100 px-1.5 text-xs tabular-nums text-slate-600">{total}</span>
            </a>
          ))}
        </nav>
      )}

      {sections.length === 0 ? (
        <EmptyState title="No dealerships yet" description="Add a dealership to start monitoring its news." />
      ) : (
        <div className="space-y-8">
          {sections.map(({ dealer, total, rows: preview }) => {
            const rows = single ? single.rows : preview;
            const location = [dealer.city, dealer.state].filter(Boolean).join(", ");
            return (
              <section key={dealer.id} id={`dealer-${dealer.id}`} aria-labelledby={`dealer-${dealer.id}-title`} className="scroll-mt-20">
                <header className="mb-3 flex flex-wrap items-end justify-between gap-3 border-b border-slate-200 pb-2">
                  <div className="min-w-0">
                    <h2 id={`dealer-${dealer.id}-title`} className="flex flex-wrap items-center gap-2 text-lg font-semibold text-slate-900">
                      <Link href={`/dealerships/${dealer.id}?tab=news`} className="hover:underline">
                        {dealer.name}
                      </Link>
                      <Badge tone={total ? "accent" : "neutral"}>
                        {total} article{total === 1 ? "" : "s"}
                      </Badge>
                      {!dealer.newsEnabled && <Badge>News monitoring off</Badge>}
                    </h2>
                    <p className="text-sm text-slate-500">{[dealer.brand, location].filter(Boolean).join(" · ")}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {status === "new" && rows.length > 0 && (
                      <form action={markAllReviewedAction}>
                        <input type="hidden" name="ids" value={rows.map((r) => r.id).join(",")} />
                        <SubmitButton className="btn btn-sm" confirm={`Mark these ${rows.length} ${dealer.name} articles as reviewed?`}>
                          Mark {rows.length === total ? "all" : `these ${rows.length}`} as reviewed
                        </SubmitButton>
                      </form>
                    )}
                    {!dealershipId && total > rows.length && (
                      <Link href={qs({ dealership: dealer.id })} className="btn btn-sm">
                        View all {total}
                      </Link>
                    )}
                  </div>
                </header>

                {rows.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-3 text-sm text-slate-500">
                    {scope === "dealership" ? "No dealership news matches these filters." : "No articles match these filters."}
                  </p>
                ) : (
                  <ArticleList rows={rows} tz={tz} minScore={settings.newsAlertMinScore} />
                )}
                {single && <Pagination page={page} totalPages={Math.ceil(total / PAGE_SIZE)} hrefFor={(p) => qs({ dealership: dealer.id, p })} />}
              </section>
            );
          })}
        </div>
      )}

      <p className="mt-6 text-xs text-slate-500">
        {grandTotal} article{grandTotal === 1 ? "" : "s"}
        {!dealershipId && sections.length > 1 ? ` across ${sections.length} dealerships` : ""} · times shown in {tz.replace(/_/g, " ")} time. When a source gives only a date, no time is shown.
      </p>
    </>
  );
}
