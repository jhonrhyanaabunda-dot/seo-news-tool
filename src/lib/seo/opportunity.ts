/**
 * What an opportunity is, and how a list of them is ordered.
 *
 * Pure module: no database, no environment. The query layer fills these in from
 * a scan, and the dashboard, the opportunities page and the printed report all
 * consume the same shape and the same ordering — which is what stops the three
 * surfaces from disagreeing about what matters most.
 */
import type { IssuePriority, ReportGroup } from "./priority";
import { PRIORITY_ORDER } from "./priority";

export interface Opportunity {
  checkKey: string;
  /** Client-facing name of the problem, e.g. "Missing page titles". */
  title: string;
  priority: IssuePriority;
  group: ReportGroup;
  groupLabel: string;
  /** Why it matters, in the check catalogue's own words. */
  why: string;
  /** What to do about it, in the check catalogue's own words. */
  action: string;
  /** Underlying stored severity, kept so callers can link into the issue filters. */
  severity: string;
  /**
   * How much of the site is affected. A site-wide check (a missing sitemap,
   * say) is not "1 page" — it has no page count at all, and saying otherwise
   * would be an invented number.
   */
  scope: "site" | "page";
  /** Distinct affected pages for a page-scoped check; null for a site-wide one. */
  affectedPages: number | null;
  /** How many issue rows back this opportunity, whatever its scope. */
  findings: number;
}

/**
 * Most important first, then widest reach, then the check key.
 *
 * The final tie-break is what makes the order stable: without it two findings
 * of equal priority and reach could swap places between renders, and the
 * dashboard's "top five" would stop matching the first five rows of the page.
 */
export function compareOpportunities(a: Opportunity, b: Opportunity): number {
  return (
    PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
    (b.affectedPages ?? 0) - (a.affectedPages ?? 0) ||
    a.checkKey.localeCompare(b.checkKey)
  );
}

/** Counts per priority, for the summary strip above the list. */
export function countByPriority(list: Opportunity[]): Record<IssuePriority, number> {
  const out: Record<IssuePriority, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const o of list) out[o.priority]++;
  return out;
}

/** How the scope reads in a sentence, without inventing a page count. */
export function scopeLabel(o: Opportunity): string {
  if (o.scope === "site") return "Affects the whole website";
  const n = o.affectedPages ?? 0;
  if (n === 0) return `${o.findings} ${o.findings === 1 ? "finding" : "findings"}`;
  return `${n} ${n === 1 ? "page" : "pages"} affected`;
}
