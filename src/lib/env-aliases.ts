/**
 * Friendly crawler setting names, accepted alongside the original ones so
 * existing deployments keep working. The original name wins when both are set.
 *
 *   MAX_PAGES_PER_DEALERSHIP  → CRAWLER_DEFAULT_MAX_PAGES  pages analysed per scan
 *   MAX_CONCURRENT_REQUESTS   → JOB_CONCURRENCY            jobs a worker runs at once (each site is still crawled one request at a time)
 *   REQUEST_DELAY             → CRAWLER_DELAY_MS           ms between requests to the same site
 *   REQUEST_TIMEOUT           → CRAWLER_TIMEOUT_MS         ms before a request times out
 *   MAX_RETRIES               → CRAWLER_MAX_RETRIES        retries for transient failures (never for refusals)
 */
export const ENV_ALIASES: Record<string, string> = {
  MAX_PAGES_PER_DEALERSHIP: "CRAWLER_DEFAULT_MAX_PAGES",
  MAX_CONCURRENT_REQUESTS: "JOB_CONCURRENCY",
  REQUEST_DELAY: "CRAWLER_DELAY_MS",
  REQUEST_TIMEOUT: "CRAWLER_TIMEOUT_MS",
  MAX_RETRIES: "CRAWLER_MAX_RETRIES",
};

export function applyEnvAliases(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...source };
  for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
    const value = source[alias];
    if ((out[canonical] === undefined || out[canonical] === "") && value !== undefined && value !== "") out[canonical] = value;
  }
  return out;
}
