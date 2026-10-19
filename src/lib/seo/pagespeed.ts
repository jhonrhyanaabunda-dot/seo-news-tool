import "server-only";
import { env } from "@/lib/env";
import { parsePageSpeedResponse, type PageSpeedResponse, type PageSpeedResult } from "./web-vitals";

/**
 * Google PageSpeed Insights (Lighthouse run in Google's cloud).
 *
 * This is how we obtain real lab performance metrics (LCP, CLS, TBT) without
 * running Chromium ourselves — something serverless functions cannot do
 * reliably — plus CrUX field data (real Chrome users) when Google has enough
 * traffic for the page. Optional: only runs when PAGESPEED_API_KEY is configured.
 *
 * Results are displayed for context but deliberately NOT part of the SEO
 * score: Lighthouse numbers vary from run to run, and the score must be
 * reproducible for the same site under the same conditions.
 */
export type { PageSpeedResult } from "./web-vitals";

export function pageSpeedEnabled(): boolean {
  return Boolean(env().PAGESPEED_API_KEY);
}

export async function runPageSpeed(url: string, strategy: "mobile" | "desktop" = "mobile", timeoutMs = 60000): Promise<PageSpeedResult> {
  const empty = { performance: null, lcpMs: null, cls: null, tbtMs: null, fcpMs: null, strategy };
  const key = env().PAGESPEED_API_KEY;
  if (!key) return { ...empty, error: "Not configured" };
  const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  api.searchParams.set("url", url);
  api.searchParams.set("strategy", strategy);
  api.searchParams.set("category", "performance");
  api.searchParams.set("key", key);
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ...empty, error: `PageSpeed API returned HTTP ${res.status}` };
    return parsePageSpeedResponse((await res.json()) as PageSpeedResponse, strategy);
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "PageSpeed request failed" };
  }
}
