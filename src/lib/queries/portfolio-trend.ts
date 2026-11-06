/**
 * The portfolio line from each dealership's score changes: for every day in the
 * window, every dealership's latest score as of that day, averaged. Days before
 * any dealership has a score are left out. Pure, so it is tested directly.
 *
 * `changes` holds at most one score per dealership per day. A score dated
 * `firstDay` may have been carried in from before the window.
 */
export function carryScoresForward(
  firstDay: string,
  lastDay: string,
  changes: ReadonlyArray<{ dealershipId: number; day: string; score: number }>,
): Array<{ day: string; score: number; dealerships: number }> {
  const byDay = new Map<string, Array<(typeof changes)[number]>>();
  for (const c of changes) byDay.set(c.day, [...(byDay.get(c.day) ?? []), c]);
  const current = new Map<number, number>();
  const out: Array<{ day: string; score: number; dealerships: number }> = [];
  // Calendar days as UTC dates: no time zone can make one repeat or go missing here.
  const last = Date.parse(`${lastDay}T00:00:00Z`);
  for (let t = Date.parse(`${firstDay}T00:00:00Z`); t <= last; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    for (const c of byDay.get(day) ?? []) current.set(c.dealershipId, c.score);
    if (current.size === 0) continue;
    let sum = 0;
    for (const score of current.values()) sum += score;
    out.push({ day, score: Math.round(sum / current.size), dealerships: current.size });
  }
  return out;
}
