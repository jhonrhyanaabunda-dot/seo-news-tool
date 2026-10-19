import { ScoreHistoryChart } from "@/components/charts";
import { Card, PriorityBadge, ScoreBadge, ScoreDelta } from "@/components/ui";
import { fmtDate } from "@/components/format";
import { HISTORY_MONTHS, alignToMonths, compareMonths, monthOf, type CheckChange } from "@/lib/history/monthly";
import { getMonthlySnapshots } from "@/lib/history/snapshots";
import { monthLabel, monthsEndingWith, previousMonth } from "@/lib/history/monthly";

/**
 * Twelve months of SEO health from the long-term monthly snapshots, which
 * outlive the scan detail that is pruned after the 10 newest scans. Each point
 * is the latest full check of that month; a month without one is a gap, never
 * an invented value.
 */
export async function MonthlyHistory({ dealershipId, tz }: { dealershipId: number; tz: string }) {
  const current = monthOf(new Date(), tz);
  const months = monthsEndingWith(current, HISTORY_MONTHS);
  const snapshots = await getMonthlySnapshots(dealershipId, months[0], current);
  const aligned = alignToMonths(snapshots, months);
  const points = months.map((m, i) => ({ label: monthLabel(m), score: aligned[i]?.score ?? null }));
  const latest = snapshots[snapshots.length - 1] ?? null;
  const before = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const cmp = latest ? compareMonths(latest, before) : null;

  return (
    <Card
      title="Monthly history"
      description={`Latest full check of each month, last ${HISTORY_MONTHS} months. Kept long-term, after per-scan details are removed.`}
    >
      {snapshots.length === 0 ? (
        <p className="text-sm text-slate-500">No monthly history yet. A month is recorded when a full check of the website completes; blocked or partial checks are not used.</p>
      ) : (
        <div className="space-y-5">
          <ScoreHistoryChart points={points} />
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] text-sm">
              <caption className="sr-only">Score and open issues per month</caption>
              <thead>
                <tr className="text-left text-xs text-slate-500">
                  <th scope="col" className="py-1.5 pr-3 font-medium">Month</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Score</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Critical</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">Warnings</th>
                  <th scope="col" className="py-1.5 font-medium">Based on check of</th>
                </tr>
              </thead>
              <tbody>
                {[...snapshots].reverse().map((s) => (
                  <tr key={s.month} className="border-t border-slate-100">
                    <td className="py-1.5 pr-3">{monthLabel(s.month)}</td>
                    <td className="py-1.5 pr-3 text-right">
                      <ScoreBadge score={s.score} />
                    </td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{s.criticalCount}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{s.warningCount}</td>
                    <td className="py-1.5 text-slate-500">{fmtDate(s.scanCompletedAt, tz)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {cmp && latest && (
            <div>
              <h3 className="text-sm font-semibold text-slate-900">
                {monthLabel(latest.month)} compared with {before ? monthLabel(before.month) : "the month before"}{" "}
                {cmp.scoreDelta !== null && (
                  <span className="ml-1 align-middle">
                    <ScoreDelta delta={cmp.scoreDelta} />
                  </span>
                )}
              </h3>
              {!before ? (
                <p className="mt-1 text-sm text-slate-600">This is the first recorded month, so there is nothing to compare with yet.</p>
              ) : (
                <>
                  {before.month !== previousMonth(latest.month) && (
                    <p className="mt-1 text-xs text-slate-500">No full check was recorded for the month in between, so this compares with the latest month that has one.</p>
                  )}
                  <div className="mt-3 grid gap-4 md:grid-cols-2">
                    <ChangeList title="New issues" items={cmp.newChecks} empty="No new kinds of issue." render={(c) => `${c.after} ${c.after === 1 ? "page" : "pages"}`} />
                    <ChangeList title="Resolved" items={cmp.resolvedChecks} empty="Nothing resolved." render={(c) => `was ${c.before}`} />
                    <ChangeList title="Improved" items={cmp.improved} empty="None." render={(c) => `${c.before} → ${c.after}`} />
                    <ChangeList title="Got worse" items={cmp.worsened} empty="None." render={(c) => `${c.before} → ${c.after}`} />
                  </div>
                  {cmp.unchanged > 0 && (
                    <p className="mt-2 text-xs text-slate-500">
                      {cmp.unchanged} other {cmp.unchanged === 1 ? "issue is" : "issues are"} unchanged.
                    </p>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function ChangeList({ title, items, empty, render }: { title: string; items: CheckChange[]; empty: string; render: (c: CheckChange) => string }) {
  return (
    <div>
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">
        {title} ({items.length})
      </h4>
      {items.length === 0 ? (
        <p className="text-sm text-slate-500">{empty}</p>
      ) : (
        <ul className="space-y-1 text-sm">
          {items.map((c) => (
            <li key={c.checkKey} className="flex items-start justify-between gap-2">
              <span className="flex min-w-0 items-start gap-2">
                <PriorityBadge priority={c.priority} />
                <span className="break-words">{c.title}</span>
              </span>
              <span className="shrink-0 tabular-nums text-xs text-slate-500">{render(c)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
