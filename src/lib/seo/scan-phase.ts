/** How a running scan is described to people. Shared by the server-rendered banner and its live updates. */
export function scanPhaseText(status: string, crawlPhase: string | null, progress: { done: number; total: number }): string {
  if (status === "queued") return "waiting for the crawler to start";
  if (status === "finalizing") return "calculating results";
  if (crawlPhase === "links") return `checking links (${progress.done} pages crawled)`;
  if (progress.total === 0) return "loading the homepage";
  return `${progress.done} of ${progress.total} pages checked`;
}
