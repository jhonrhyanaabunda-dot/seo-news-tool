import type { ReportFindings } from "@/lib/reports/types";
import { Card } from "@/components/ui";
import { fmtNumber } from "@/components/format";

function change(cur: number, prev: number | undefined | null): string | null {
  if (prev === undefined || prev === null || prev === 0) return null;
  const pct = Math.round(((cur - prev) / prev) * 100);
  return `${pct > 0 ? "+" : ""}${pct}% vs previous 28 days`;
}

/**
 * Search Console and Google listing figures in a report. Rendered only when the
 * findings carry them (the integrations are optional). Context only — the SEO
 * score above does not include them.
 */
export function ReportSearchSection({ findings: f }: { findings: ReportFindings }) {
  const sc = f.searchConsole;
  const gl = f.googleListing;
  if (!sc && !gl) return null;
  return (
    <Card title="Search visibility" description="From Google Search Console and the Google listing. Shown for context; not part of the SEO score.">
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        {sc && (
          <>
            <div>
              <dt className="text-slate-500">Clicks from Google</dt>
              <dd className="font-semibold tabular-nums">{fmtNumber(sc.clicks)}</dd>
              {change(sc.clicks, sc.previous?.clicks) && <dd className="text-xs text-slate-500">{change(sc.clicks, sc.previous?.clicks)}</dd>}
            </div>
            <div>
              <dt className="text-slate-500">Impressions</dt>
              <dd className="font-semibold tabular-nums">{fmtNumber(sc.impressions)}</dd>
              {change(sc.impressions, sc.previous?.impressions) && <dd className="text-xs text-slate-500">{change(sc.impressions, sc.previous?.impressions)}</dd>}
            </div>
            <div>
              <dt className="text-slate-500">Click-through rate</dt>
              <dd className="font-semibold tabular-nums">{sc.ctrPct}%</dd>
            </div>
            <div>
              <dt className="text-slate-500">Average position</dt>
              <dd className="font-semibold tabular-nums">{sc.position ?? "—"}</dd>
            </div>
          </>
        )}
        {gl && (
          <>
            <div>
              <dt className="text-slate-500">Google rating</dt>
              <dd className="font-semibold tabular-nums">{gl.rating === null ? "—" : `${gl.rating.toFixed(1)} ★`}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Google reviews</dt>
              <dd className="font-semibold tabular-nums">{fmtNumber(gl.reviewCount)}</dd>
            </div>
          </>
        )}
      </dl>
      {sc && (
        <p className="mt-3 text-xs text-slate-500">
          Search Console, {sc.periodStart} to {sc.periodEnd}.{gl && ` Google listing checked ${gl.capturedOn}.`}
        </p>
      )}
      {!sc && gl && <p className="mt-3 text-xs text-slate-500">Google listing checked {gl.capturedOn}.</p>}
    </Card>
  );
}
