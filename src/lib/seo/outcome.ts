/**
 * Scan outcome: what a finished scan was able to evaluate. This is what QA
 * reads to tell "real SEO problems" apart from "pages we could not evaluate
 * because the website restricted access".
 */
export type ScanOutcome = "completed" | "completed_with_warnings" | "partially_blocked" | "blocked" | "failed";

export const OUTCOME_META: Record<ScanOutcome, { label: string; tone: "success" | "warning" | "critical" | "info"; description: string }> = {
  completed: { label: "Completed", tone: "success", description: "Every selected page was evaluated." },
  completed_with_warnings: {
    label: "Completed with warnings",
    tone: "info",
    description: "The scan finished, but some pages could not be loaded (timeouts or server errors) or the website was down.",
  },
  partially_blocked: {
    label: "Partially blocked",
    tone: "warning",
    description: "The website restricted automated access to some pages. Those pages were not evaluated and are not counted as SEO problems.",
  },
  blocked: {
    label: "Blocked",
    tone: "warning",
    description: "This dealership website restricted automated access. SEO results for inaccessible pages were not evaluated. Requires review.",
  },
  failed: { label: "Failed", tone: "critical", description: "The scan could not be completed because of an error." },
};

export function computeOutcome(i: {
  crawlBlocked: boolean;
  siteAvailable: boolean;
  pagesBlocked: number;
  pagesNotEvaluated: number;
  pagesFailedOther: number;
  stoppedForBlock: boolean;
}): ScanOutcome {
  if (i.crawlBlocked) return "blocked";
  if (i.pagesBlocked > 0 || i.pagesNotEvaluated > 0 || i.stoppedForBlock) return "partially_blocked";
  if (!i.siteAvailable || i.pagesFailedOther > 0) return "completed_with_warnings";
  return "completed";
}
