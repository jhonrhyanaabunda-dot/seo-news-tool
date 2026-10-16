import type { PerformanceSnapshot, WebVitalRating } from "@/lib/db/schema";
import type { SpeedData } from "@/lib/queries/performance";
import { RATING_LABEL, VITAL_THRESHOLDS, ratePerformanceScore, rateVital } from "@/lib/seo/web-vitals";
import { ScoreHistoryChart } from "@/components/charts";
import { Badge, Card, cn } from "@/components/ui";
import { displayUrl, fmtDate } from "@/components/format";

/**
 * Core Web Vitals from the stored PageSpeed Insights snapshots. Server
 * component, presentation only: values and ratings come from the snapshot rows
 * and Google's published thresholds. Never part of the SEO score.
 */

const TONE: Record<WebVitalRating, "success" | "warning" | "critical"> = { good: "success", needs_improvement: "warning", poor: "critical" };

const fmtMs = (ms: number | null | undefined) => (ms === null || ms === undefined ? "—" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const fmtCls = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));

function Rated({ value, rating }: { value: string; rating: WebVitalRating | null }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <span className="font-semibold tabular-nums text-slate-900">{value}</span>
      {rating && <Badge tone={TONE[rating]}>{RATING_LABEL[rating]}</Badge>}
    </span>
  );
}

function PageVitals({ title, s }: { title: string; s: PerformanceSnapshot }) {
  const f = s.field;
  const rows = [
    { label: "Largest Contentful Paint", hint: `good ≤ ${VITAL_THRESHOLDS.lcpMs[0] / 1000} s, poor > ${VITAL_THRESHOLDS.lcpMs[1] / 1000} s`, field: f ? { v: fmtMs(f.lcpMs), r: f.lcpCategory ?? rateVital("lcpMs", f.lcpMs) } : null, lab: { v: fmtMs(s.lcpMs), r: rateVital("lcpMs", s.lcpMs) } },
    { label: "Interaction to Next Paint", hint: `good ≤ ${VITAL_THRESHOLDS.inpMs[0]} ms, poor > ${VITAL_THRESHOLDS.inpMs[1]} ms`, field: f ? { v: fmtMs(f.inpMs), r: f.inpCategory ?? rateVital("inpMs", f.inpMs) } : null, lab: null },
    { label: "Cumulative Layout Shift", hint: `good ≤ ${VITAL_THRESHOLDS.cls[0]}, poor > ${VITAL_THRESHOLDS.cls[1]}`, field: f ? { v: fmtCls(f.cls), r: f.clsCategory ?? rateVital("cls", f.cls) } : null, lab: { v: fmtCls(s.cls), r: rateVital("cls", s.cls) } },
    { label: "Total Blocking Time", hint: "lab only; stands in for interactivity", field: null, lab: { v: fmtMs(s.tbtMs), r: rateVital("tbtMs", s.tbtMs) } },
    { label: "First Contentful Paint", hint: "lab only", field: null, lab: { v: fmtMs(s.fcpMs), r: rateVital("fcpMs", s.fcpMs) } },
  ];
  return (
    <div className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
        <span className="text-sm text-slate-600">
          Performance <Rated value={s.performance === null ? "—" : `${s.performance}/100`} rating={ratePerformanceScore(s.performance)} />
        </span>
      </div>
      <p className="mb-2 break-all text-xs text-slate-500">{displayUrl(s.url)}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-slate-500">
              <th className="py-1 pr-3 font-medium">Metric</th>
              <th className="py-1 pr-3 font-medium">Real users{f?.scope === "origin" ? " (whole site)" : ""}</th>
              <th className="py-1 font-medium">Lab test</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => (
              <tr key={r.label}>
                <td className="py-1.5 pr-3 text-slate-700">
                  {r.label}
                  <span className="block text-xs text-slate-400">{r.hint}</span>
                </td>
                <td className="py-1.5 pr-3">{r.field ? <Rated value={r.field.v} rating={r.field.r} /> : <span className="text-slate-400">—</span>}</td>
                <td className="py-1.5">{r.lab ? <Rated value={r.lab.v} rating={r.lab.r} /> : <span className="text-slate-400">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function SpeedCard({ speed, tz, className }: { speed: SpeedData; tz: string; className?: string }) {
  const latest = speed.home ?? speed.vdp;
  return (
    <Card
      className={className}
      title="Speed"
      description={
        latest
          ? `Core Web Vitals from Google PageSpeed Insights (mobile), measured ${fmtDate(latest.capturedAt, tz)}. "Real users" is Chrome field data where Google has enough visits. Shown for context; not part of the SEO score.`
          : "Core Web Vitals from Google PageSpeed Insights (mobile). Shown for context; not part of the SEO score."
      }
    >
      {!latest ? (
        <p className="text-sm text-slate-500">
          {!speed.configured
            ? "Speed measurements are not configured. Add a PAGESPEED_API_KEY to measure Core Web Vitals weekly."
            : speed.lastError
              ? `The last measurement did not succeed: ${speed.lastError}. It is retried automatically.`
              : "No measurement yet. The homepage and one vehicle page are measured after the next completed scan, then weekly."}
        </p>
      ) : (
        <div className="space-y-5">
          <div className={cn("grid gap-5", speed.home && speed.vdp && "xl:grid-cols-2")}>
            {speed.home && <PageVitals title="Homepage" s={speed.home} />}
            {speed.vdp && <PageVitals title="Vehicle detail page" s={speed.vdp} />}
          </div>
          {speed.trend.length >= 2 && (
            <div>
              <h3 className="mb-1 text-sm font-semibold text-slate-900">Homepage performance score over time</h3>
              <ScoreHistoryChart points={speed.trend.map((p) => ({ label: fmtDate(p.at, tz), score: p.performance }))} height={150} good={90} name="Homepage performance score" unit="measurements" />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
