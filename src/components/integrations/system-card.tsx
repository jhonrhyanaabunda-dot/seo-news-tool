import { HoverPrefetchLink as Link } from "@/components/client/hover-prefetch-link";
import { gscStatus, placesConfigured } from "@/lib/integrations/config";
import { disconnectGoogleAction } from "@/app/actions/integrations";
import { SubmitButton } from "@/components/client/submit-button";
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
const GOOGLE_RESULT: Record<string, { tone: "success" | "warning" | "info"; text: string }> = {
  connected: { tone: "success", text: "Search Console is connected. Each dealership with a Search Console property syncs within about 10 minutes." },
  disconnected: { tone: "info", text: "Search Console was disconnected and Google's access was revoked." },
  cancelled: { tone: "info", text: "Connecting was cancelled on Google's screen; nothing changed." },
  expired: { tone: "warning", text: "That sign-in link expired or was opened in another browser. Press Connect with Google again." },
  failed: { tone: "warning", text: "Google did not complete the connection. Try again; if it repeats, System → logs has the reason." },
  "not-configured": { tone: "warning", text: "The Google OAuth client is not set up yet (GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET)." },
};

export async function DataIntegrationsCard({ googleResult }: { googleResult?: string } = {}) {
  const gsc = await gscStatus();
  const result = googleResult ? GOOGLE_RESULT[googleResult] : undefined;
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
      {result && <p className={`mb-3 rounded-md px-3 py-2 text-sm ring-1 ring-inset ${result.tone === "success" ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : result.tone === "warning" ? "bg-amber-50 text-amber-800 ring-amber-200" : "bg-slate-50 text-slate-700 ring-slate-200"}`}>{result.text}</p>}
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
          {gsc.method === "oauth" && (
            <div className="mt-1 text-xs text-slate-500">
              Connected with <span className="break-all font-medium text-slate-700">{gsc.connectedEmail ?? "a Google account"}</span>
              {gsc.connectedAt ? <> since {fmtRelative(gsc.connectedAt)}</> : null}. That account needs access to each dealership&apos;s Search Console property.
              <form action={disconnectGoogleAction} className="mt-1.5">
                <SubmitButton className="btn btn-sm" confirm="Disconnect Search Console? Syncing stops until someone connects again." pendingText="Disconnecting…">
                  Disconnect
                </SubmitButton>
              </form>
            </div>
          )}
          {!gsc.configured && gsc.oauthAvailable && (
            <div className="mt-1.5 text-xs text-slate-500">
              {/* A plain link, not a prefetching one: it starts the sign-in round trip. */}
              <a href="/api/integrations/google/start" className="btn btn-sm">
                Connect with Google
              </a>
              <p className="mt-1">Sign in with a Google account that has access to the dealerships&apos; Search Console properties. Read-only.</p>
            </div>
          )}
          {!gsc.configured && !gsc.problem && !gsc.oauthAvailable && <p className="mt-1 text-xs text-slate-500">Set GOOGLE_SERVICE_ACCOUNT_JSON, or a Google OAuth client for &quot;Connect with Google&quot; (see README).</p>}
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
