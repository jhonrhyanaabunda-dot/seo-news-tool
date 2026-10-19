import Link from "next/link";
import { gscConfig, placesConfigured } from "@/lib/integrations/config";
import { getIntegrationOverview } from "@/lib/integrations/queries";
import type { DealershipIntegration } from "@/lib/db/schema";
import { Badge, Card, TableWrap } from "@/components/ui";
import { fmtRelative } from "@/components/format";

function StatusBadge({ s, configured, current }: { s: DealershipIntegration | null; configured: boolean; current: string | null }) {
  if (!configured) return <Badge>Not connected</Badge>;
  if (!current) return <span className="text-slate-400">—</span>;
  if (!s || s.configKey !== current || (s.status === "pending" && !s.lastSyncedAt)) return <Badge tone="info">Waiting for first sync</Badge>;
  if (s.status === "error") return <Badge tone="warning">Failed</Badge>;
  return <Badge tone="success">Synced {fmtRelative(s.lastSyncedAt)}</Badge>;
}

/** Admin System page: connection status of the Google integrations and per-dealership sync state. */
export async function DataIntegrationsCard() {
  const gsc = gscConfig();
  const places = placesConfigured();
  const overview = await getIntegrationOverview();
  const failures = overview.dealerships.flatMap((d) =>
    [
      d.gsc?.status === "error" && d.gsc.configKey === d.gscProperty ? { id: d.id, name: d.name, what: "Search Console", error: d.gsc.lastError } : null,
      d.places?.status === "error" && d.places.configKey === d.googlePlaceId ? { id: d.id, name: d.name, what: "Google listing", error: d.places.lastError } : null,
    ].filter((x): x is { id: number; name: string; what: string; error: string | null } => x !== null),
  );
  return (
    <Card title="Search Console, Google listing and competitors" description="Informational data shown on each dealership's Search performance tab; never part of the SEO score." className="mb-5">
      <ul className="mb-4 grid gap-2 text-sm sm:grid-cols-3">
        <li>
          <div className="flex justify-between gap-2">
            Search Console <Badge tone={gsc.configured ? "success" : gsc.problem ? "warning" : "neutral"}>{gsc.configured ? "Connected" : gsc.problem ? "Misconfigured" : "Not configured"}</Badge>
          </div>
          {gsc.problem && <p className="mt-1 text-xs text-amber-800">{gsc.problem}</p>}
          {gsc.serviceAccountEmail && (
            <p className="mt-1 text-xs text-slate-500">
              Add <span className="break-all font-mono text-slate-700">{gsc.serviceAccountEmail}</span> as a user on each Search Console property.
            </p>
          )}
          {!gsc.configured && !gsc.problem && <p className="mt-1 text-xs text-slate-500">Set GOOGLE_SERVICE_ACCOUNT_JSON (see README).</p>}
        </li>
        <li>
          <div className="flex justify-between gap-2">
            Google listing (Places API) <Badge tone={places ? "success" : "neutral"}>{places ? "Connected" : "Not configured"}</Badge>
          </div>
          {!places && <p className="mt-1 text-xs text-slate-500">Set GOOGLE_PLACES_API_KEY (see README).</p>}
        </li>
        <li>
          <div className="flex justify-between gap-2">
            Competitors <span className="font-medium tabular-nums">{overview.competitorCount}</span>
          </div>
          <p className="mt-1 text-xs text-slate-500">Homepages checked weekly; no credentials needed.</p>
        </li>
      </ul>
      {overview.dealerships.length > 0 && (
        <TableWrap caption="Data integration sync status per dealership">
          <thead>
            <tr>
              <th scope="col">Dealership</th>
              <th scope="col">Search Console</th>
              <th scope="col">Google listing</th>
            </tr>
          </thead>
          <tbody>
            {overview.dealerships.map((d) => (
              <tr key={d.id}>
                <td>
                  <Link href={`/dealerships/${d.id}?tab=search`} className="font-medium text-slate-900 hover:underline">
                    {d.name}
                  </Link>
                </td>
                <td>
                  <StatusBadge s={d.gsc} configured={gsc.configured} current={d.gscProperty} />
                </td>
                <td>
                  <StatusBadge s={d.places} configured={places} current={d.googlePlaceId} />
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      {failures.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {failures.map((f) => (
            <li key={`${f.id}-${f.what}`} className="text-amber-900">
              <strong>
                {f.name} · {f.what}:
              </strong>{" "}
              {f.error}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
