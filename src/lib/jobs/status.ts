/**
 * The public crawl-job status used by the dashboard and the crawl-job API.
 * Pure mapping from a scan's lifecycle status and its outcome.
 *
 * A scan that analysed what it could while some (or all) pages were protected
 * is PARTIAL, never FAILED: FAILED is reserved for the monitor itself failing.
 */
export type CrawlJobStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "PARTIAL" | "FAILED";

export function crawlJobStatus(scan: { status: string; outcome: string | null }): CrawlJobStatus {
  switch (scan.status) {
    case "queued":
      return "QUEUED";
    case "crawling":
    case "finalizing":
      return "RUNNING";
    case "completed":
      return scan.outcome === "partially_blocked" || scan.outcome === "blocked" ? "PARTIAL" : "COMPLETED";
    default:
      return "FAILED"; // failed, cancelled
  }
}
