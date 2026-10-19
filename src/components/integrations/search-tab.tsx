import Link from "next/link";
import { RefreshCw } from "lucide-react";
import type { Dealership } from "@/lib/db/schema";
import type { SearchTabData } from "@/lib/integrations/queries";
import { pctChange, type GscTotals } from "@/lib/integrations/gsc";
import { comparisonRows, type CellTone } from "@/lib/integrations/competitor-metrics";
import { syncIntegrationsNowAction } from "@/app/actions/integrations";
import { TrendChart } from "@/components/charts";
import { SubmitButton } from "@/components/client/submit-button";
import { Badge, Card, EmptyState, ExternalLink, Notice, StatCard, TableWrap, cn } from "@/components/ui";
import { displayUrl, fmtDate, fmtNumber, fmtRelative } from "@/components/format";

/**
 * "Search performance" tab: Search Console traffic, the Google listing and a
 * homepage comparison with competitors. All three are context next to the SEO
 * score and never feed into it. Dealership logins only see sections that are
 * connected; A3 staff also see "Not connected" states, admins with setup steps.
 */
export function SearchPerformanceTab({ dealer, data, isAdmin, isClient, tz, sync }: { dealer: Dealership; data: SearchTabData; isAdmin: boolean; isClient: boolean; tz: string; sync?: string }) {
  const showSearch = !isClient || Boolean(data.search && data.gsc.configured);
  const showListing = !isClient || Boolean(data.listing && data.placesConfigured);
  const showCompetitors = !isClient || Boolean(data.competitors);
  return (
    <div className="space-y-5">
      {sync === "queued" && <Notice tone="success">Sync started. New figures appear here within a few minutes.</Notice>}
      {sync === "nothing" && <Notice tone="info">Nothing to sync yet: connect Search Console, the Google listing or add competitors first.</Notice>}
      {sync === "rate-limited" && <Notice tone="warning">Too many sync requests in the last hour. Please wait before trying again.</Notice>}
      {isAdmin && (
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Link href={`/admin/dealerships/${dealer.id}/edit`} className="btn btn-sm">
            Connect data sources
          </Link>
          <form action={syncIntegrationsNowAction}>
            <input type="hidden" name="id" value={dealer.id} />
            <SubmitButton className="btn btn-sm" pendingText="Starting…">
              <RefreshCw aria-hidden className="h-3.5 w-3.5" /> Sync now
            </SubmitButton>
          </form>
        </div>
      )}
      {showSearch && <SearchConsoleSection data={data} isAdmin={isAdmin} isClient={isClient} tz={tz} />}
      {showListing && <ListingSection data={data} isAdmin={isAdmin} isClient={isClient} tz={tz} />}
      {showCompetitors && <CompetitorsSection dealer={dealer} data={data} isAdmin={isAdmin} tz={tz} />}
    </div>
  );
}

/* ─────────────────────────── Search Console ─────────────────────────── */

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function deltaHint(current: number, previous: number | null | undefined) {
  const change = pctChange(current, previous);
  if (change === null) return "No earlier period to compare";
  const rounded = Math.round(change);
  return `${rounded > 0 ? "+" : ""}${rounded}% vs previous 28 days`;
}

function deltaTone(current: number, previous: number | null | undefined, higherIsBetter = true): "success" | "warning" | "neutral" {
  const change = pctChange(current, previous);
  if (change === null || Math.abs(change) < 5) return "neutral";
  return change > 0 === higherIsBetter ? "success" : "warning";
}

function positionHint(cur: GscTotals, prev: GscTotals | null) {
  if (cur.position === null) return "No impressions";
  if (!prev || prev.position === null) return "No earlier period to compare";
  const diff = Math.round((cur.position - prev.position) * 10) / 10;
  if (diff === 0) return "Unchanged vs previous 28 days";
  // Lower positions are better (1 = top of the results).
  return `${diff < 0 ? "Up" : "Down"} ${Math.abs(diff)} vs previous 28 days`;
}

function SearchConsoleSection({ data, isAdmin, isClient, tz }: { data: SearchTabData; isAdmin: boolean; isClient: boolean; tz: string }) {
  const s = data.search;
  const title = "Search performance";
  const description = "Google Search Console: the latest 28 days with data compared with the 28 days before. Not part of the SEO score.";
  if (!data.gsc.configured) {
    return (
      <Card title={title} description={description}>
        <EmptyState
          title="Search Console is not connected"
          description={isAdmin ? <SetupHint kind="gsc" problem={data.gsc.problem} /> : "An administrator can connect Google Search Console to show clicks, impressions and top searches here."}
        />
      </Card>
    );
  }
  if (!s) {
    return (
      <Card title={title} description={description}>
        <EmptyState
          title="No Search Console property for this dealership"
          description={
            isAdmin ? (
              <>
                Add the property (e.g. <code>sc-domain:example.com</code>) under Edit → Google data, then add <strong>{data.gsc.serviceAccountEmail}</strong> as a user on that property in Search Console.
              </>
            ) : (
              "An administrator can add this dealership's Search Console property."
            )
          }
        />
      </Card>
    );
  }
  const st = s.status;
  const pendingSync = !st || st.configKey !== s.property || (st.status === "pending" && !st.lastSyncedAt);
  const c = s.comparison;
  return (
    <Card
      title={title}
      description={description}
      actions={
        <span className="text-xs text-slate-500">
          {!isClient && <span className="mr-2 font-mono">{s.property}</span>}
          {st?.lastSyncedAt ? `Updated ${fmtRelative(st.lastSyncedAt)}` : null}
        </span>
      }
    >
      {st?.status === "error" && st.configKey === s.property && (
        <Notice tone="warning">{isClient ? "The latest Search Console update did not complete; the figures below may be a few days old." : <>Search Console sync failed: {st.lastError}</>}</Notice>
      )}
      {!c ? (
        <EmptyState
          title={pendingSync ? "Waiting for the first sync" : "No search data yet"}
          description={pendingSync ? "Search Console data is read once a day; the first sync runs within a few minutes of connecting the property." : "Search Console reported no impressions for this property yet."}
        />
      ) : (
        <>
          <p className="mb-3 text-xs text-slate-500">
            {fmtDate(`${c.periodStart}T12:00:00Z`, tz)} – {fmtDate(`${c.periodEnd}T12:00:00Z`, tz)} · Search Console data arrives two to three days late.
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard label="Clicks" value={fmtNumber(c.current.clicks)} hint={deltaHint(c.current.clicks, c.previous?.clicks)} tone={deltaTone(c.current.clicks, c.previous?.clicks)} />
            <StatCard label="Impressions" value={fmtNumber(c.current.impressions)} hint={deltaHint(c.current.impressions, c.previous?.impressions)} tone={deltaTone(c.current.impressions, c.previous?.impressions)} />
            <StatCard label="Average CTR" value={pct(c.current.ctr)} hint={c.previous ? `${pct(c.previous.ctr)} in the previous 28 days` : "No earlier period to compare"} />
            <StatCard label="Average position" value={c.current.position === null ? "—" : c.current.position.toFixed(1)} hint={positionHint(c.current, c.previous)} />
          </div>
          {s.weekly.length > 1 && (
            <div className="mt-5 grid gap-5 lg:grid-cols-2">
              <div>
                <h3 className="mb-1 text-sm font-semibold text-slate-900">Clicks per week</h3>
                <TrendChart label="Clicks per week" points={s.weekly.map((w) => ({ label: fmtDate(`${w.weekEnd}T12:00:00Z`, tz), value: w.clicks }))} />
              </div>
              <div>
                <h3 className="mb-1 text-sm font-semibold text-slate-900">Impressions per week</h3>
                <TrendChart label="Impressions per week" points={s.weekly.map((w) => ({ label: fmtDate(`${w.weekEnd}T12:00:00Z`, tz), value: w.impressions }))} />
              </div>
            </div>
          )}
          <div className="mt-5 grid gap-5 lg:grid-cols-2">
            <TopTable title="Top searches" caption="Top search queries, last 28 days" items={s.topQueries} render={(k) => <span className="break-words">{k}</span>} />
            <TopTable
              title="Top pages"
              caption="Top pages in Google Search, last 28 days"
              items={s.topPages}
              render={(k) => (
                <ExternalLink href={k} className="text-xs">
                  {displayUrl(k)}
                </ExternalLink>
              )}
            />
          </div>
        </>
      )}
    </Card>
  );
}

function TopTable({ title, caption, items, render }: { title: string; caption: string; items: Array<{ key: string; clicks: number; impressions: number; ctr: number; position: number | null }>; render: (key: string) => React.ReactNode }) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 text-sm font-semibold text-slate-900">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">None reported for this period. (Google hides very rare searches for privacy.)</p>
      ) : (
        <TableWrap caption={caption}>
          <thead>
            <tr>
              <th scope="col">{title === "Top pages" ? "Page" : "Search"}</th>
              <th scope="col" className="text-right">
                Clicks
              </th>
              <th scope="col" className="text-right">
                Impr.
              </th>
              <th scope="col" className="text-right">
                Pos.
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.key}>
                <td className="max-w-[18rem]">{render(i.key)}</td>
                <td className="text-right tabular-nums">{fmtNumber(i.clicks)}</td>
                <td className="text-right tabular-nums">{fmtNumber(i.impressions)}</td>
                <td className="text-right tabular-nums">{i.position === null ? "—" : i.position.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </div>
  );
}

/* ─────────────────────────── Google listing ─────────────────────────── */

function ListingSection({ data, isAdmin, isClient, tz }: { data: SearchTabData; isAdmin: boolean; isClient: boolean; tz: string }) {
  const title = "Google listing";
  const description = "The dealership's Google Business Profile as Google shows it (Places API). Informational; not part of the SEO score.";
  if (!data.placesConfigured) {
    return (
      <Card title={title} description={description}>
        <EmptyState title="Google listing data is not connected" description={isAdmin ? <SetupHint kind="places" problem={null} /> : "An administrator can connect the Google listing to show the rating and reviews here."} />
      </Card>
    );
  }
  const l = data.listing;
  if (!l) {
    return (
      <Card title={title} description={description}>
        <EmptyState title="No Google listing selected" description={isAdmin ? "Pick the listing under Edit → Google data → Find place." : "An administrator can link this dealership's Google listing."} />
      </Card>
    );
  }
  const s = l.latest;
  const failed = l.status?.status === "error" && l.status.configKey === l.placeId;
  return (
    <Card title={title} description={description} actions={s ? <span className="text-xs text-slate-500">Checked {fmtRelative(s.capturedAt)}</span> : undefined}>
      {failed && <Notice tone="warning">{isClient ? "The latest listing check did not complete; the figures below may be out of date." : <>Google listing check failed: {l.status?.lastError}</>}</Notice>}
      {!s ? (
        <EmptyState title="Waiting for the first check" description="The listing is read once a week; the first check runs within a few minutes of linking it." />
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Rating" value={s.rating === null ? "—" : `${s.rating.toFixed(1)} ★`} hint={l.change?.rating ? `${l.change.rating > 0 ? "+" : ""}${l.change.rating} since ${fmtDate(l.change.since, tz)}` : "Average of Google reviews"} />
            <StatCard
              label="Reviews"
              value={fmtNumber(s.reviewCount)}
              hint={l.change && l.change.reviews !== null ? `${l.change.reviews >= 0 ? "+" : ""}${l.change.reviews} since ${fmtDate(l.change.since, tz)}` : "Change shown after about 30 days of checks"}
              tone={l.change?.reviews && l.change.reviews > 0 ? "success" : "neutral"}
            />
            <StatCard
              label="Business status"
              value={<span className="text-lg">{s.businessStatus === "OPERATIONAL" ? "Open" : s.businessStatus ? s.businessStatus.replace(/_/g, " ").toLowerCase() : "Unknown"}</span>}
              tone={s.businessStatus && s.businessStatus !== "OPERATIONAL" ? "critical" : "success"}
              hint={s.data.hasOpeningHours ? "Opening hours listed" : "No opening hours listed"}
            />
          </div>
          {l.flags.length > 0 && (
            <ul className="mt-4 space-y-1.5 text-sm">
              {l.flags.map((f) => (
                <li key={f.key} className="flex items-start gap-2">
                  <Badge tone={f.tone}>{f.tone === "critical" ? "Check now" : f.tone === "warning" ? "Check" : "Note"}</Badge>
                  <span className="text-slate-700">{f.message}</span>
                </li>
              ))}
            </ul>
          )}
          <dl className="mt-4 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {s.data.name && (
              <div>
                <dt className="text-slate-500">Listed as</dt>
                <dd className="text-slate-900">{s.data.name}</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-500">Address</dt>
              <dd className="text-slate-900">{s.data.formattedAddress ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Phone</dt>
              <dd className="text-slate-900">{s.data.nationalPhoneNumber ?? "—"}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Website on the listing</dt>
              <dd>{s.data.websiteUri ? <ExternalLink href={s.data.websiteUri}>{displayUrl(s.data.websiteUri)}</ExternalLink> : "—"}</dd>
            </div>
          </dl>
          {s.data.googleMapsUri && (
            <p className="mt-3 text-sm">
              <ExternalLink href={s.data.googleMapsUri}>Open in Google Maps</ExternalLink>
            </p>
          )}
          {l.history.filter((h) => h.reviewCount !== null).length > 1 && (
            <div className="mt-5">
              <h3 className="mb-1 text-sm font-semibold text-slate-900">Review count</h3>
              <TrendChart label="Google review count" points={l.history.map((h) => ({ label: fmtDate(h.capturedAt, tz), value: h.reviewCount }))} />
            </div>
          )}
        </>
      )}
    </Card>
  );
}

/* ─────────────────────────── Competitors ─────────────────────────── */

const CELL_TONE: Record<CellTone, string> = { good: "text-emerald-700", bad: "text-amber-800 font-medium", neutral: "text-slate-700" };

function CompetitorsSection({ dealer, data, isAdmin, tz }: { dealer: Dealership; data: SearchTabData; isAdmin: boolean; tz: string }) {
  const title = "Competitors";
  const description = "Homepage comparison: each competitor's homepage is read once a week by the same crawler (robots.txt honoured). This compares homepages only; it is not an SEO score.";
  const comp = data.competitors;
  if (!comp) {
    return (
      <Card title={title} description={description}>
        <EmptyState
          title="No competitors added"
          description={
            isAdmin ? (
              <>
                Add up to three competitor websites under{" "}
                <Link href={`/admin/dealerships/${dealer.id}/edit`} className="underline">
                  Edit
                </Link>
                .
              </>
            ) : (
              "An administrator can add up to three competitor websites to compare with."
            )
          }
        />
      </Card>
    );
  }
  const rows = comparisonRows([comp.dealership.metrics, ...comp.competitors.map((c) => c.metrics)]);
  return (
    <Card title={title} description={description}>
      {!comp.dealership.detailsAvailable && (
        <p className="mb-3 text-xs text-slate-500">The dealership&apos;s homepage details are not available from its latest scan (not scanned yet, or the details were archived); its column shows Google figures only.</p>
      )}
      <TableWrap caption={`Homepage comparison: ${dealer.name} and competitors`}>
        <thead>
          <tr>
            <th scope="col">Homepage</th>
            <th scope="col">
              <span className="font-semibold text-slate-900">{dealer.name}</span>
              <div className="text-xs font-normal text-slate-500">{comp.dealership.scanCompletedAt ? `Latest scan, ${fmtDate(comp.dealership.scanCompletedAt, tz)}` : "No scan yet"}</div>
            </th>
            {comp.competitors.map((c) => (
              <th scope="col" key={c.id}>
                <span className="font-semibold text-slate-900">{c.name}</span>
                <div className="text-xs font-normal text-slate-500">
                  <ExternalLink href={c.websiteUrl}>{displayUrl(c.websiteUrl)}</ExternalLink>
                </div>
                <div className="mt-0.5 text-xs font-normal">
                  {!c.snapshot ? (
                    <Badge>Not checked yet</Badge>
                  ) : c.snapshot.status === "blocked" ? (
                    <span title={c.snapshot.error ?? undefined}>
                      <Badge tone="warning">Blocked</Badge>
                    </span>
                  ) : c.snapshot.status === "error" ? (
                    <span title={c.snapshot.error ?? undefined}>
                      <Badge tone="warning">Unreachable</Badge>
                    </span>
                  ) : (
                    <span className="text-slate-500">Checked {fmtDate(c.snapshot.capturedAt, tz)}</span>
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <th scope="row" className="text-left font-medium text-slate-700" title={r.hint}>
                {r.label}
              </th>
              {r.cells.map((cell, i) => (
                <td key={i} className={cn("tabular-nums", CELL_TONE[cell.tone])}>
                  {cell.text}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </TableWrap>
      {comp.competitors.some((c) => c.snapshot && c.snapshot.status !== "ok") && (
        <ul className="mt-3 space-y-1 text-xs text-slate-500">
          {comp.competitors
            .filter((c) => c.snapshot && c.snapshot.status !== "ok")
            .map((c) => (
              <li key={c.id}>
                <strong>{c.name}:</strong> {c.snapshot!.error ?? "Not checked."} {c.snapshot!.status === "blocked" && "The monitor does not get around such restrictions."}
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}

/* ─────────────────────────── Admin setup ─────────────────────────── */

function SetupHint({ kind, problem }: { kind: "gsc" | "places"; problem: string | null }) {
  return (
    <span className="block text-left">
      {problem && <span className="mb-2 block font-medium text-amber-800">Configuration problem: {problem}</span>}
      {kind === "gsc" ? (
        <>
          In Google Cloud, enable the <strong>Google Search Console API</strong>, create a service account with a JSON key, and set <code>GOOGLE_SERVICE_ACCOUNT_JSON</code> (or <code>GOOGLE_SERVICE_ACCOUNT_EMAIL</code> + <code>GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY</code>) in the environment, then redeploy. Add the service account&apos;s email as a user on each Search Console property. See the README section
          “Search Console, Google listing and competitors”.
        </>
      ) : (
        <>
          In Google Cloud, enable <strong>Places API (New)</strong> (billing required), create an API key restricted to that API, set <code>GOOGLE_PLACES_API_KEY</code> and redeploy. Then pick each dealership&apos;s listing under Edit → Google data → Find place.
        </>
      )}
    </span>
  );
}
