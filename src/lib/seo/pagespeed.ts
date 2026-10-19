import "server-only";
import { env } from "@/lib/env";

/**
 * Google PageSpeed Insights (Lighthouse run in Google's cloud).
 *
 * This is how we obtain real lab performance metrics (LCP, CLS, TBT) without
 * running Chromium ourselves — something serverless functions cannot do
 * reliably. Optional: only runs when PAGESPEED_API_KEY is configured.
 *
 * Results are displayed for context but deliberately NOT part of the SEO
 * score: Lighthouse numbers vary from run to run, and the score must be
 * reproducible for the same site under the same conditions.
 */
export interface PageSpeedResult {
  performance: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  strategy: string;
  error?: string;
}

export function pageSpeedEnabled(): boolean {
  return Boolean(env().PAGESPEED_API_KEY);
}

export async function runPageSpeed(url: string, strategy: "mobile" | "desktop" = "mobile", timeoutMs = 60000): Promise<PageSpeedResult> {
  const key = env().PAGESPEED_API_KEY;
  if (!key) return { performance: null, lcpMs: null, cls: null, tbtMs: null, fcpMs: null, strategy, error: "Not configured" };
  const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  api.searchParams.set("url", url);
  api.searchParams.set("strategy", strategy);
  api.searchParams.set("category", "performance");
  api.searchParams.set("key", key);
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { performance: null, lcpMs: null, cls: null, tbtMs: null, fcpMs: null, strategy, error: `PageSpeed API returned HTTP ${res.status}` };
    const data = (await res.json()) as {
      lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Record<string, { numericValue?: number }> };
    };
    const audits = data.lighthouseResult?.audits ?? {};
    const num = (k: string) => (typeof audits[k]?.numericValue === "number" ? audits[k].numericValue! : null);
    const perf = data.lighthouseResult?.categories?.performance?.score;
    return {
      performance: typeof perf === "number" ? Math.round(perf * 100) : null,
      lcpMs: num("largest-contentful-paint") !== null ? Math.round(num("largest-contentful-paint")!) : null,
      cls: num("cumulative-layout-shift") !== null ? Math.round(num("cumulative-layout-shift")! * 1000) / 1000 : null,
      tbtMs: num("total-blocking-time") !== null ? Math.round(num("total-blocking-time")!) : null,
      fcpMs: num("first-contentful-paint") !== null ? Math.round(num("first-contentful-paint")!) : null,
      strategy,
    };
  } catch (err) {
    return { performance: null, lcpMs: null, cls: null, tbtMs: null, fcpMs: null, strategy, error: err instanceof Error ? err.message : "PageSpeed request failed" };
  }
}
