import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { seoIssues } from "@/lib/db/schema";
import { CHECKS_BY_KEY } from "@/lib/seo/checks/config";
import { REPORT_GROUPS, priorityFor, reportGroupFor } from "@/lib/seo/priority";
import { compareOpportunities, type Opportunity } from "@/lib/seo/opportunity";

/**
 * One definition of "what this dealership should do next", used by the
 * dashboard summary, the opportunities page and — later — the printed report.
 *
 * An opportunity is not a new kind of finding. It is one of the scanner's own
 * checks, failing on a real scan, presented with the wording the check already
 * carries: `problem` as the title, `description` as why it matters,
 * `recommendation` as the action. Priority and grouping come from the existing
 * `priorityFor` / `reportGroupFor` tables. Nothing here invents a severity, a
 * business impact or a score, because the moment this module starts deciding
 * facts it becomes a second source of truth and the PDF can disagree with the
 * screen.
 *
 * The ordering is deterministic and shared, which is what keeps the dashboard's
 * top five identical to the first five rows on the opportunities page.
 */

/**
 * Every open opportunity in one scan, most important first.
 *
 * Ties are broken by reach, then alphabetically by check key, so the order is
 * stable across requests and between the dashboard, the page and the report.
 * Returns an empty list when the scan's detail rows have been pruned — callers
 * must disclose that rather than present it as a clean site.
 */
export type { Opportunity };

export async function getOpportunities(scanId: number): Promise<Opportunity[]> {
  const rows = await db
    .select({
      checkKey: seoIssues.checkKey,
      severity: seoIssues.severity,
      affectedPages: sql<number>`count(distinct ${seoIssues.pageId})::int`,
      findings: sql<number>`count(*)::int`,
    })
    .from(seoIssues)
    .where(eq(seoIssues.scanId, scanId))
    .groupBy(seoIssues.checkKey, seoIssues.severity);

  return rows
    .map((r): Opportunity => {
      const def = CHECKS_BY_KEY[r.checkKey];
      const group = reportGroupFor(r.checkKey);
      const scope = def?.scope === "site" ? "site" : "page";
      return {
        checkKey: r.checkKey,
        title: def?.problem ?? r.checkKey,
        priority: priorityFor(r.checkKey, r.severity),
        group,
        groupLabel: REPORT_GROUPS[group],
        why: def?.description ?? "",
        action: def?.recommendation ?? "",
        severity: r.severity,
        scope,
        affectedPages: scope === "site" ? null : Number(r.affectedPages),
        findings: Number(r.findings),
      };
    })
    .sort(compareOpportunities);
}
