import { Notice } from "@/components/ui";

/**
 * Housekeeping keeps per-issue rows for only the ten most recent scans per
 * dealership; older scans keep their score and their issue totals but lose the
 * individual records behind them.
 *
 * Without saying so, an older scan reads as "15 warnings, and here are none of
 * them", which a dealership fairly reads as a broken page or as no issues at
 * all. These two notices exist so the counts and the empty list can be true at
 * the same time, and so the reason is on the page rather than in a changelog.
 */

/** Details were deliberately removed by retention. The totals are still exact. */
export function DetailsPrunedNotice() {
  return (
    <Notice tone="info">
      <strong>Detailed issue records were not retained for this scan.</strong> The issue totals shown are preserved and remain accurate, but the
      individual issue records are no longer available. Full detail is kept for the ten most recent scans of each dealership.
    </Notice>
  );
}

/**
 * The scan is marked as keeping its details, yet none came back. That should not
 * happen, so it is reported as unknown rather than as "no issues" — claiming a
 * clean scan here would be the one genuinely misleading answer.
 */
export function DetailsUnavailableNotice() {
  return (
    <Notice tone="warning">
      <strong>Issue details could not be loaded for this scan.</strong> The totals shown come from the scan record and are accurate; the individual
      issue records are missing. This is unexpected — please report it rather than treating the scan as having no issues.
    </Notice>
  );
}
