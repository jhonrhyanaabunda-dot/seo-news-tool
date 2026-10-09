import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Image from "next/image";
import { getCurrentUser } from "@/lib/auth/session";
import { canAccessDealership, requireDealershipAccess } from "@/lib/auth/tenant";
import { env } from "@/lib/env";
import { getClientDashboard } from "@/lib/queries/client-dashboard";
import { getOpportunities } from "@/lib/queries/client-opportunities";
import { buildExecutiveSummary } from "@/lib/reports/print-summary";
import { countByPriority, scopeLabel, type Opportunity } from "@/lib/seo/opportunity";
import { ScoreHistoryChart } from "@/components/charts";
import { fmtDate, fmtDateTime } from "@/components/format";

export const dynamic = "force-dynamic";

/** Enough to act on without becoming a database export; the rest stays in the dashboard. */
const MAX_OPPORTUNITIES = 8;

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const user = await getCurrentUser();
  const n = Number(id);
  if (!user || !Number.isInteger(n) || !(await canAccessDealership(user, n))) return { title: "SEO report" };
  const data = await getClientDashboard(n);
  return { title: data ? `SEO report — ${data.dealership.name}` : "SEO report" };
}

export default async function PrintReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dealershipId = Number(id);
  if (!Number.isInteger(dealershipId) || dealershipId <= 0) notFound();
  // Same guard as the dashboard and the opportunities page: a report is never
  // reachable by editing the id in the address bar.
  await requireDealershipAccess(dealershipId);

  const data = await getClientDashboard(dealershipId);
  if (!data) notFound();

  const tz = env().APP_TIMEZONE;
  const { dealership: d, scan, counts, pages } = data;
  const opportunities = scan ? await getOpportunities(scan.id) : [];
  const shown = opportunities.slice(0, MAX_OPPORTUNITIES);
  const byPriority = countByPriority(opportunities);
  const host = d.websiteUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");

  const summary = buildExecutiveSummary({
    score: scan?.score ?? null,
    previousScore: scan?.previousScore ?? null,
    scoreDelta: scan?.scoreDelta ?? null,
    critical: counts.critical,
    warning: counts.warning,
    pagesScanned: scan?.pagesScanned ?? 0,
    pagesHealthy: pages.healthy,
    pagesNotEvaluated: pages.notEvaluated,
    opportunityCount: opportunities.length,
    topPriority: opportunities[0]?.priority ?? null,
    siteAvailable: scan?.siteAvailable ?? null,
    detailsRetained: scan?.detailsRetained ?? true,
  });

  return (
    <div className="print-doc">
      {/* ── Cover ───────────────────────────────────────────────────── */}
      <header className="doc-cover">
        <div className="doc-brand">
          <Image src="/a3brands-logo.png" alt="A3 Brands" width={1388} height={879} priority className="doc-logo" />
          <span className="doc-brand-name">A3 SEO Monitor</span>
        </div>
        <h1 className="doc-title">SEO Performance Report</h1>
        <p className="doc-dealer">{d.name}</p>
        <p className="doc-site">{host}</p>
        <dl className="doc-meta">
          <div>
            <dt>Report date</dt>
            <dd>{fmtDate(new Date(), tz)}</dd>
          </div>
          <div>
            <dt>Based on website check</dt>
            <dd>{scan?.completedAt ? fmtDateTime(scan.completedAt, tz) : "No completed check yet"}</dd>
          </div>
          {(d.city || d.state) && (
            <div>
              <dt>Location</dt>
              <dd>{[d.city, d.state].filter(Boolean).join(", ")}</dd>
            </div>
          )}
          <div>
            <dt>Brand</dt>
            <dd>{d.brand}</dd>
          </div>
        </dl>
      </header>

      {!scan ? (
        <section className="doc-section">
          <h2>No results yet</h2>
          <p className="doc-body">
            This website has not completed an SEO check yet. The first check runs automatically and usually finishes within a few minutes; a full report will be available once it
            has.
          </p>
        </section>
      ) : (
        <>
          {/* ── Executive summary ─────────────────────────────────── */}
          <section className="doc-section">
            <h2>Executive summary</h2>
            <div className="doc-kpis">
              <Kpi label="SEO health score" value={scan.score === null ? "—" : String(scan.score)} sub={scan.score === null ? "Not scored" : "out of 100"} />
              <Kpi
                label="Change"
                value={scan.scoreDelta === null ? "—" : `${scan.scoreDelta > 0 ? "+" : ""}${scan.scoreDelta}`}
                sub={scan.scoreDelta === null ? "No previous score" : `from ${scan.previousScore}`}
              />
              <Kpi label="Pages monitored" value={String(scan.pagesScanned)} sub={pages.notEvaluated > 0 ? `${pages.notEvaluated} not reachable` : "all reachable"} />
              <Kpi label="Critical findings" value={String(counts.critical)} sub={counts.critical === 0 ? "none open" : "need attention"} />
              <Kpi label="Warnings" value={String(counts.warning)} sub={counts.warning === 0 ? "none open" : "worth fixing"} />
              <Kpi label="Open opportunities" value={String(opportunities.length)} sub={opportunities.length === 0 ? "none" : "listed in this report"} />
            </div>
            {summary.map((p, i) => (
              <p key={i} className="doc-body">
                {p}
              </p>
            ))}
          </section>

          {/* ── Score over time ───────────────────────────────────── */}
          <section className="doc-section doc-keep">
            <h2>SEO health over time</h2>
            {data.trend.length > 1 ? (
              <>
                <div className="doc-chart">
                  <ScoreHistoryChart points={data.trend.map((p) => ({ label: fmtDate(p.at, tz), score: p.score }))} height={200} />
                </div>
                <p className="doc-note">
                  Each point is a completed check of this website. Range shown: {fmtDate(data.trend[0].at, tz)} to {fmtDate(data.trend[data.trend.length - 1].at, tz)}.
                </p>
              </>
            ) : (
              <p className="doc-body">
                This website has {data.trend.length === 1 ? "one scored check so far" : "no scored checks yet"}, so there is not yet enough history to show a trend. The trend will
                appear in future reports as more checks complete.
              </p>
            )}
          </section>

          {/* ── Pages monitored ───────────────────────────────────── */}
          <section className="doc-section doc-keep">
            <h2>Pages monitored</h2>
            <table className="doc-table">
              <tbody>
                <PageRow label="Healthy — no findings" value={pages.healthy} total={pages.total} />
                <PageRow label="With warnings" value={pages.warning} total={pages.total} />
                <PageRow label="With critical findings" value={pages.critical} total={pages.total} />
                {pages.notEvaluated > 0 && <PageRow label="Could not be checked (blocked by the website)" value={pages.notEvaluated} total={pages.total} />}
                <tr className="doc-total">
                  <th scope="row">Total pages monitored</th>
                  <td className="doc-num">{pages.total}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </section>

          {/* ── Findings and opportunities ────────────────────────── */}
          {!scan.detailsRetained && counts.critical + counts.warning > 0 ? (
            <section className="doc-section">
              <h2>Findings</h2>
              <p className="doc-body">
                Detailed records are retained for recent checks only. This report includes the summary metrics available for the check it was built from — the totals above remain
                accurate — but the individual findings behind them are no longer stored and cannot be listed here.
              </p>
            </section>
          ) : opportunities.length === 0 ? (
            <section className="doc-section">
              <h2>Findings</h2>
              <p className="doc-body">No SEO findings were recorded for this website in the latest check. Nothing currently requires attention.</p>
            </section>
          ) : (
            <>
              <section className="doc-section doc-keep">
                <h2>Findings by priority</h2>
                <table className="doc-table">
                  <thead>
                    <tr>
                      <th scope="col">Priority</th>
                      <th scope="col" className="doc-num">
                        Open
                      </th>
                      <th scope="col">What it means</th>
                    </tr>
                  </thead>
                  <tbody>
                    <PriorityRow label="Critical" n={byPriority.CRITICAL} meaning="Can stop pages appearing correctly in search results." />
                    <PriorityRow label="High" n={byPriority.HIGH} meaning="Directly affects how well pages perform in search." />
                    <PriorityRow label="Medium" n={byPriority.MEDIUM} meaning="Worth fixing; limited or indirect impact." />
                    <PriorityRow label="Low" n={byPriority.LOW} meaning="Best-practice refinements." />
                  </tbody>
                </table>
              </section>

              <section className="doc-section">
                <h2>Top SEO opportunities</h2>
                <p className="doc-note">
                  Ordered by priority, then by how much of the website each one affects. This is the same order shown in the A3 SEO Monitor dashboard.
                </p>
                <ol className="doc-opps">
                  {shown.map((o, i) => (
                    <OpportunityBlock key={o.checkKey} o={o} n={i + 1} />
                  ))}
                </ol>
                {opportunities.length > shown.length && (
                  <p className="doc-note">
                    {opportunities.length - shown.length} further {opportunities.length - shown.length === 1 ? "opportunity is" : "opportunities are"} open and available in the A3
                    SEO Monitor dashboard.
                  </p>
                )}
              </section>
            </>
          )}
        </>
      )}

      <footer className="doc-footer">
        <span>A3 SEO Monitor</span>
        <span>
          {d.name} · {host}
        </span>
        <span>{fmtDate(new Date(), tz)}</span>
      </footer>
    </div>
  );
}

function Kpi({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="doc-kpi">
      <span className="doc-kpi-label">{label}</span>
      <span className="doc-kpi-value">{value}</span>
      <span className="doc-kpi-sub">{sub}</span>
    </div>
  );
}

function PageRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="doc-num">{value}</td>
      <td className="doc-pct">{total > 0 ? `${pct}%` : "—"}</td>
    </tr>
  );
}

function PriorityRow({ label, n, meaning }: { label: string; n: number; meaning: string }) {
  return (
    <tr>
      <th scope="row">{label}</th>
      <td className="doc-num">{n}</td>
      <td>{meaning}</td>
    </tr>
  );
}

/**
 * One opportunity, in the catalogue's own words. Numbered rather than
 * colour-coded so the priority survives a black-and-white printer.
 */
function OpportunityBlock({ o, n }: { o: Opportunity; n: number }) {
  return (
    <li className="doc-opp doc-keep">
      <div className="doc-opp-head">
        <span className="doc-opp-n">{n}</span>
        <h3 className="doc-opp-title">{o.title}</h3>
      </div>
      <dl className="doc-opp-meta">
        <div>
          <dt>Priority</dt>
          <dd>
            <span className={`doc-pri doc-pri-${o.priority.toLowerCase()}`}>{o.priority.charAt(0) + o.priority.slice(1).toLowerCase()}</span>
          </dd>
        </div>
        <div>
          <dt>Scope</dt>
          <dd>{scopeLabel(o)}</dd>
        </div>
        <div>
          <dt>Area</dt>
          <dd>{o.groupLabel}</dd>
        </div>
      </dl>
      {o.why && (
        <p className="doc-opp-line">
          <span className="doc-opp-k">What we check</span>
          {o.why}
        </p>
      )}
      {o.action && (
        <p className="doc-opp-line">
          <span className="doc-opp-k">Recommended action</span>
          {o.action}
        </p>
      )}
    </li>
  );
}
