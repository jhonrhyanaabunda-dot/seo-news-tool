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

/**
 * APP_DATABASE_URL / APP_DATABASE_URL_UNPOOLED point the app at a database other than the one a
 * Vercel Marketplace integration manages (it owns DATABASE_URL and the integration's variables cannot
 * be edited). Unlike the aliases above, these win: setting them is the switch, deleting them switches back.
 */
export function databaseUrls(source: Record<string, string | undefined>): { url: string | undefined; unpooled: string | undefined } {
  const pick = (...vals: Array<string | undefined>) => vals.find((v) => v !== undefined && v !== "");
  const override = pick(source.APP_DATABASE_URL);
  if (override) return { url: supabaseSessionMode(override), unpooled: pick(source.APP_DATABASE_URL_UNPOOLED) };
  return { url: pick(source.DATABASE_URL), unpooled: pick(source.DATABASE_URL_UNPOOLED) };
}

/**
 * Supabase's transaction pooler (Supavisor, port 6543) can leave a connection stuck mid-query when
 * postgres.js pipelines several queries on it. On Vercel one function instance serves many requests
 * through a shared pool of 3, so three stuck connections hung every page until the 300 s timeout
 * (2026-10-27). The session pooler on the same host (port 5432) passes the protocol straight
 * through; with idle_timeout 20 s the few connections it holds are released quickly.
 */
export function supabaseSessionMode(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname.endsWith(".pooler.supabase.com") && u.port === "6543") {
      u.port = "5432";
      return u.toString();
    }
  } catch {
    /* not a URL: leave it for the env validation to report */
  }
  return url;
}

export function applyEnvAliases(source: Record<string, string | undefined>): Record<string, string | undefined> {
  const out = { ...source };
  const db = databaseUrls(source);
  out.DATABASE_URL = db.url;
  out.DATABASE_URL_UNPOOLED = db.unpooled;
  for (const [alias, canonical] of Object.entries(ENV_ALIASES)) {
    const value = source[alias];
    if ((out[canonical] === undefined || out[canonical] === "") && value !== undefined && value !== "") out[canonical] = value;
  }
  return out;
}
