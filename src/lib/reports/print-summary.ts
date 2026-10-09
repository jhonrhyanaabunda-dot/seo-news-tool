/**
 * The report's opening paragraph, composed from facts rather than written.
 *
 * Pure module: no database, no model. Every sentence is emitted only when the
 * value behind it exists, so a scan with no previous score simply has no
 * comparison sentence instead of a hedged one. That is the whole design — a
 * deterministic narrative cannot drift from the numbers printed beside it, and
 * cannot claim a traffic or ranking improvement the system never measured.
 */
import type { IssuePriority } from "@/lib/seo/priority";

export interface SummaryFacts {
  score: number | null;
  previousScore: number | null;
  scoreDelta: number | null;
  critical: number;
  warning: number;
  pagesScanned: number;
  pagesHealthy: number;
  pagesNotEvaluated: number;
  opportunityCount: number;
  topPriority: IssuePriority | null;
  siteAvailable: boolean | null;
  detailsRetained: boolean;
}

const countWord = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Returns the paragraphs of the executive summary. Each is independently
 * omitted when its facts are missing, so the result is always true of the data
 * even for a sparse or pruned scan.
 */
export function buildExecutiveSummary(f: SummaryFacts): string[] {
  const out: string[] = [];

  if (f.siteAvailable === false) {
    out.push("The website could not be reached during this check, so no SEO health score could be calculated. Until the site responds, the findings below cannot be refreshed.");
    return out;
  }

  // Opening: the score, and what moved it.
  if (f.score !== null) {
    let opening = `The latest check produced an SEO health score of ${f.score} out of 100`;
    if (f.scoreDelta !== null && f.previousScore !== null) {
      opening +=
        f.scoreDelta === 0
          ? `, unchanged from the previous check.`
          : `, ${f.scoreDelta > 0 ? "up" : "down"} ${Math.abs(f.scoreDelta)} ${Math.abs(f.scoreDelta) === 1 ? "point" : "points"} from ${f.previousScore}.`;
    } else {
      opening += ". This is the first scored check of this website, so there is no previous score to compare against.";
    }
    out.push(opening);
  } else {
    out.push("This check did not produce an SEO health score.");
  }

  // What was found, and across how much of the site.
  if (f.detailsRetained) {
    const findings =
      f.critical === 0 && f.warning === 0
        ? "No critical findings or warnings were recorded"
        : `${[f.critical > 0 ? countWord(f.critical, "critical finding") : null, f.warning > 0 ? countWord(f.warning, "warning") : null].filter(Boolean).join(" and ")} ${
            f.critical + f.warning === 1 ? "was" : "were"
          } recorded`;
    out.push(`${findings} across ${countWord(f.pagesScanned, "monitored page")}.`);
  } else {
    out.push(
      `${f.critical + f.warning === 0 ? "No critical findings or warnings were recorded" : `${countWord(f.critical, "critical finding")} and ${countWord(f.warning, "warning")} were recorded`} across ${countWord(
        f.pagesScanned,
        "monitored page",
      )}. Detailed records for this check are no longer retained, so the totals above are shown without the individual findings behind them.`,
    );
  }

  // What to do about it.
  if (f.detailsRetained && f.opportunityCount > 0) {
    out.push(
      `${countWord(f.opportunityCount, "improvement opportunity", "improvement opportunities")} ${f.opportunityCount === 1 ? "is" : "are"} open${
        f.topPriority ? `, the most important of which ${f.opportunityCount === 1 ? "is" : "are"} rated ${f.topPriority.toLowerCase()} priority` : ""
      }. The recommended actions are listed later in this report.`,
    );
  } else if (f.detailsRetained) {
    out.push("No improvement opportunities are open for this website based on this check.");
  }

  // Pages the site itself refused: worth stating so the page count adds up.
  if (f.pagesNotEvaluated > 0) {
    out.push(
      `${countWord(f.pagesNotEvaluated, "page")} could not be analysed because the website's own security blocked automated access. These are access restrictions rather than SEO problems, and are excluded from the findings above.`,
    );
  }

  return out;
}
