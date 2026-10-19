import Link from "next/link";
import { ScoreHistoryChart } from "@/components/charts";
import { Card, EmptyState, cn } from "@/components/ui";

export const TREND_WINDOWS = [30, 60, 90] as const;
export type TrendWindow = (typeof TREND_WINDOWS)[number];

/**
 * Management's view across the portfolio: the average score over time, and which
 * dealerships moved most in the last 30 days. Everything comes from stored scans
 * that read the site (blocked checks are left out, as everywhere else).
 */
export function PortfolioTrends({
  trend,
  movers,
  window,
  hrefFor,
  formatDay,
}: {
  trend: Array<{ day: string; score: number; dealerships: number }>;
  movers: Array<{ id: number; name: string; now: number; before: number; delta: number }>;
  window: TrendWindow;
  hrefFor: (w: TrendWindow) => string;
  formatDay: (day: string) => string;
}) {
  const first = trend[0]?.score;
  const last = trend[trend.length - 1]?.score;
  const change = first !== undefined && last !== undefined && trend.length > 1 ? last - first : null;
  return (
    <div className="mb-6 grid items-start gap-5 lg:grid-cols-3">
      <Card
        className="lg:col-span-2"
        title="Portfolio score"
        description={change === null ? "Average SEO score across your dealerships." : `Average SEO score across your dealerships: ${last}/100, ${change === 0 ? "unchanged" : `${change > 0 ? "up" : "down"} ${Math.abs(change)}`} over ${window} days.`}
        actions={
          <nav aria-label="Trend period" className="flex gap-1">
            {TREND_WINDOWS.map((w) => (
              <Link
                key={w}
                href={hrefFor(w)}
                aria-current={w === window ? "true" : undefined}
                scroll={false}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset", w === window ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}
              >
                {w} days
              </Link>
            ))}
          </nav>
        }
      >
        {trend.length > 1 ? (
          <ScoreHistoryChart points={trend.map((t) => ({ label: formatDay(t.day), score: t.score }))} />
        ) : (
          <EmptyState title="Not enough history yet" description="The portfolio trend appears once dealerships have been checked on at least two days in this period." />
        )}
      </Card>

      <Card title="Biggest changes" description="Latest score against the average of the week a month ago.">
        {movers.length === 0 ? (
          <p className="text-sm text-slate-500">Shown once dealerships have a month of scans.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {movers.slice(0, 6).map((m) => (
              <li key={m.id} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
                <Link href={`/dealerships/${m.id}`} className="min-w-0 truncate text-sm font-medium text-slate-800 hover:text-brand-700 hover:underline">
                  {m.name}
                </Link>
                <span className="flex shrink-0 items-baseline gap-2 tabular-nums">
                  <span className="text-xs text-slate-400">
                    {m.before} → {m.now}
                  </span>
                  <span className={cn("w-10 text-right text-sm font-semibold", m.delta > 0 ? "text-emerald-700" : m.delta < 0 ? "text-red-700" : "text-slate-400")}>
                    {m.delta > 0 ? `+${m.delta}` : m.delta === 0 ? "0" : `−${Math.abs(m.delta)}`}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
