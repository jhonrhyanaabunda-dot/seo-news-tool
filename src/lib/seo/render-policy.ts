import type { RenderMode } from "@/lib/db/schema";

/**
 * How a page should be fetched, given the dealership's setting and the
 * process-wide BROWSER_RENDERING mode. Pure function so it can be unit tested
 * without a database, a network or a browser.
 *
 * Rendering with a real browser is a transport decision, not a disguise: the
 * crawler keeps its honest A3SEOMonitor User-Agent and robots.txt is applied
 * before a URL ever reaches this point.
 */
export type FetchPlan =
  /** Plain HTTP only. */
  | "http-only"
  /** Render with Chromium immediately (the site needs JavaScript to serve anything). */
  | "browser-first"
  /** Plain HTTP first; escalate to Chromium only if the response is a refusal/challenge. */
  | "escalate-if-blocked";

export function planFetch(
  renderMode: RenderMode,
  globalMode: "off" | "fallback" | "always",
  opts: { headersOnly?: boolean } = {},
): FetchPlan {
  // Link checks only need response headers — never worth a browser.
  if (opts.headersOnly) return "http-only";
  // A per-dealership opt-out always wins, even when rendering is on globally.
  if (renderMode === "never") return "http-only";
  // No browser is available in this process (e.g. Vercel functions).
  if (globalMode === "off") return "http-only";
  if (renderMode === "always" || globalMode === "always") return "browser-first";
  return "escalate-if-blocked";
}
