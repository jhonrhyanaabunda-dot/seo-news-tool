import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { X } from "lucide-react";
import { requireAdmin } from "@/lib/auth/guards";
import { getDealership, getKeywords } from "@/lib/queries/dealership";
import { getSettings } from "@/lib/settings";
import { env } from "@/lib/env";
import { allRegions, regionLabel } from "@/lib/crawler/regions";
import { deleteDealershipAction, removeKeywordAction, updateDealershipAction } from "@/app/actions/dealerships";
import { DealershipForm } from "@/components/admin/dealership-form";
import { KeywordForm } from "@/components/admin/keyword-form";
import { NewsSourceForm } from "@/components/admin/news-source-form";
import { removeNewsSourceAction } from "@/app/actions/news-sources";
import { listSourcesForAdmin } from "@/lib/news/sources";
import { SOURCE_LABEL } from "@/lib/news/source-rules";
import { SubmitButton } from "@/components/client/submit-button";
import { Badge, Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Edit dealership" };
export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = { dealership: "Dealership name", group: "Dealer group", brand: "Brand", local: "Local", custom: "Custom" };

export default async function EditDealershipPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const id = Number((await params).id);
  if (!Number.isInteger(id)) notFound();
  const [d, keywords, settings] = await Promise.all([getDealership(id), getKeywords(id), getSettings()]);
  if (!d) notFound();
  const sources = await listSourcesForAdmin(d);
  const regions = allRegions(env().CRAWLER_EXTRA_REGIONS).map(({ id, label }) => ({ id, label }));
  return (
    <>
      <PageHeader
        breadcrumb={
          <>
            <Link href="/admin/dealerships" className="hover:underline">
              Dealerships
            </Link>{" "}
            /{" "}
            <Link href={`/dealerships/${id}`} className="hover:underline">
              {d.name}
            </Link>
          </>
        }
        title={`Edit ${d.name}`}
      />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <DealershipForm action={updateDealershipAction} dealership={d} defaultInterval={settings.seoIntervalHours} regions={regions} defaultRegionLabel={regionLabel(env().DEFAULT_CRAWLER_REGION, regions)} />
        </Card>
        <div className="space-y-5">
          <Card title="News keywords" description="Name, group, brand and city keywords are generated automatically. Add custom terms such as former names or key people.">
            <ul className="mb-3 flex flex-wrap gap-2">
              {keywords.map((k) => (
                <li key={k.id}>
                  {k.kind === "custom" ? (
                    <form action={removeKeywordAction} className="inline-flex items-center gap-1 rounded-full bg-brand-50 py-0.5 pl-2.5 pr-1 text-xs text-brand-700 ring-1 ring-inset ring-brand-100">
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="keywordId" value={k.id} />
                      {k.keyword}
                      <button type="submit" className="rounded-full p-0.5 hover:bg-brand-100" aria-label={`Remove keyword ${k.keyword}`}>
                        <X aria-hidden className="h-3 w-3" />
                      </button>
                    </form>
                  ) : (
                    <span title={KIND_LABEL[k.kind]}>
                      <Badge>{k.keyword}</Badge>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <KeywordForm dealershipId={id} />
          </Card>
          <Card title="News sources" description="Feeds are read before news search, most authoritative first: the dealership's own news, then manufacturer newsrooms, then other publishers. Google/Bing News search fills in the rest.">
            {sources.length === 0 ? (
              <p className="mb-3 text-sm text-slate-500">No feeds yet — news comes from search only.</p>
            ) : (
              <ul className="mb-3 divide-y divide-slate-100 text-sm">
                {sources.map((src) => (
                  <li key={src.id} className="flex items-start justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900">{src.label}</div>
                      <div className="text-xs text-slate-500">
                        {SOURCE_LABEL[src.sourceType]}
                        {src.dealershipId === null && ` · all ${src.brand} dealerships`}
                        {src.lastStatus === "error" && <span className="text-red-700"> · last read failed</span>}
                        {src.lastStatus === "ok" && " · read OK"}
                      </div>
                      <div className="truncate text-xs text-slate-400">{src.url}</div>
                    </div>
                    <form action={removeNewsSourceAction}>
                      <input type="hidden" name="id" value={id} />
                      <input type="hidden" name="sourceId" value={src.id} />
                      <button type="submit" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={`Remove feed ${src.label}`}>
                        <X aria-hidden className="h-3.5 w-3.5" />
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
            <NewsSourceForm dealershipId={id} brand={d.brand} />
          </Card>
          <Card title="Danger zone">
            <p className="mb-3 text-sm text-slate-600">Removing a dealership permanently deletes its scan history, issues and news. To pause monitoring instead, untick “Active”.</p>
            <form action={deleteDealershipAction}>
              <input type="hidden" name="id" value={id} />
              <SubmitButton className="btn-danger" confirm={`Permanently delete ${d.name} and all of its history? This cannot be undone.`} pendingText="Deleting…">
                Delete dealership
              </SubmitButton>
            </form>
          </Card>
        </div>
      </div>
    </>
  );
}
