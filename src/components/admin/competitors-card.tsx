import { X } from "lucide-react";
import { listCompetitors } from "@/lib/integrations/competitors";
import { MAX_COMPETITORS } from "@/lib/integrations/competitor-metrics";
import { removeCompetitorAction } from "@/app/actions/integrations";
import { CompetitorForm } from "@/components/admin/competitor-form";
import { Card } from "@/components/ui";
import { displayUrl } from "@/components/format";

/** Admin management of a dealership's competitors (edit page sidebar). */
export async function CompetitorsCard({ dealershipId }: { dealershipId: number }) {
  const list = await listCompetitors(dealershipId);
  return (
    <Card
      title="Competitors"
      description={`Up to ${MAX_COMPETITORS} websites whose homepages are compared with this dealership's once a week (Search performance tab). robots.txt and site security are respected.`}
    >
      {list.length === 0 ? (
        <p className="mb-3 text-sm text-slate-500">No competitors yet.</p>
      ) : (
        <ul className="mb-3 divide-y divide-slate-100 text-sm">
          {list.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-2 py-2">
              <div className="min-w-0">
                <div className="font-medium text-slate-900">{c.name}</div>
                <div className="truncate text-xs text-slate-400">{displayUrl(c.websiteUrl)}</div>
              </div>
              <form action={removeCompetitorAction}>
                <input type="hidden" name="id" value={dealershipId} />
                <input type="hidden" name="competitorId" value={c.id} />
                <button type="submit" className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label={`Remove competitor ${c.name}`}>
                  <X aria-hidden className="h-3.5 w-3.5" />
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {list.length < MAX_COMPETITORS ? <CompetitorForm dealershipId={dealershipId} /> : <p className="text-xs text-slate-500">Remove a competitor to add another.</p>}
    </Card>
  );
}
