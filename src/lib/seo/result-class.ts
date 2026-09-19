/**
 * What happened when one URL was requested, as a single class the dashboard,
 * reports and API can rely on. Pure function (no database/network) so the
 * rules are unit tested.
 *
 * Protection is classified, never circumvented: a security challenge is
 * PROTECTED, an explicit refusal is ACCESS_DENIED, a slow-down is RATE_LIMITED.
 * None of these are SEO problems — they are pages the monitor could not analyse.
 */
import type { PageResultClass } from "@/lib/db/schema";

export interface PageResultInput {
  status: "pending" | "fetched" | "failed" | "skipped";
  httpStatus: number | null;
  errorCode: string | null;
  errorMessage?: string | null;
  redirected?: boolean | null;
}

const NETWORK_CODES = new Set(["DNS", "CONNECTION", "TLS", "TOO_MANY_REDIRECTS", "UNKNOWN", "EMPTY_RESPONSE"]);
const SKIP_CODES = new Set(["ROBOTS_BLOCKED", "REDIRECT_OFFSITE", "NOT_HTML", "DUPLICATE", "UNSAFE_URL"]);

/** Returns null for a URL that has not been requested yet. */
export function classifyPageResult(p: PageResultInput): PageResultClass | null {
  if (p.status === "pending") return null;
  if (p.errorCode === "NOT_EVALUATED") return "NOT_EVALUATED";
  if (p.errorCode && SKIP_CODES.has(p.errorCode)) return "SKIPPED";
  if (p.errorCode === "BLOCKED") {
    if (p.httpStatus === 429) return "RATE_LIMITED";
    // block-detect words a recognised challenge page as "… returned a challenge page".
    if (p.errorMessage && /challenge/i.test(p.errorMessage)) return "PROTECTED";
    return "ACCESS_DENIED";
  }
  if (p.errorCode === "TIMEOUT") return "TIMEOUT";
  if (p.errorCode && NETWORK_CODES.has(p.errorCode)) return "NETWORK_ERROR";

  const s = p.httpStatus;
  if (s === null) return p.status === "skipped" ? "SKIPPED" : "NETWORK_ERROR";
  if (s === 429) return "RATE_LIMITED";
  if (s === 401 || s === 403) return "ACCESS_DENIED";
  if (s >= 500) return "SERVER_ERROR";
  if (s === 404 || s === 410) return "NOT_FOUND";
  if (s >= 400) return "CLIENT_ERROR";
  if (s >= 300) return "REDIRECT";
  return p.redirected ? "REDIRECT" : "SUCCESS";
}

/**
 * A 2xx response with no document in it — no <title> and no text at all. Seen when a
 * browser render is interrupted; scoring it would report a missing title, H1, viewport…
 * for a page that is actually fine, so it is retried and, if still empty, not analysed.
 */
export function isEmptyDocument(body: string | null): boolean {
  if (!body) return true;
  // A title, or content without text (images, links, frames, a meta refresh), means the document did arrive.
  if (/<title[\s>]|<(img|iframe|frameset|a)[\s>]|<meta[^>]+http-equiv=["']?refresh/i.test(body)) return false;
  return body.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]*>/g, "").trim().length === 0;
}

/** Pages whose content was read and analysed. */
export function isAnalyzed(c: PageResultClass | null): boolean {
  return c === "SUCCESS" || c === "REDIRECT";
}

/** Pages the monitor could not analyse because the website restricted automated access. */
export function isProtected(c: PageResultClass | null): boolean {
  return c === "PROTECTED" || c === "ACCESS_DENIED" || c === "RATE_LIMITED" || c === "NOT_EVALUATED";
}

export const RESULT_CLASS_META: Record<PageResultClass, { label: string; tone: "success" | "info" | "warning" | "critical" | "neutral"; description: string }> = {
  SUCCESS: { label: "Analyzed", tone: "success", description: "The page loaded and was analysed." },
  REDIRECT: { label: "Redirect", tone: "info", description: "The URL redirected; the destination was analysed." },
  NOT_FOUND: { label: "Not found", tone: "critical", description: "The server returned 404/410." },
  CLIENT_ERROR: { label: "Client error", tone: "warning", description: "The server returned a 4xx error." },
  PROTECTED: { label: "Protected", tone: "warning", description: "A security challenge (e.g. Cloudflare) was served instead of the page. Not analysed; not an SEO issue." },
  ACCESS_DENIED: { label: "Access denied", tone: "warning", description: "The website refused the monitor (401/403). Not analysed; not an SEO issue." },
  RATE_LIMITED: { label: "Rate limited", tone: "warning", description: "The website asked the monitor to slow down (429). Crawling of the site stopped." },
  SERVER_ERROR: { label: "Server error", tone: "critical", description: "The server returned a 5xx error." },
  TIMEOUT: { label: "Timeout", tone: "warning", description: "The page did not respond in time." },
  NETWORK_ERROR: { label: "Network error", tone: "warning", description: "DNS, connection or TLS failure, or the page came back empty. Not analysed; not counted as an SEO issue." },
  NOT_EVALUATED: { label: "Not evaluated", tone: "neutral", description: "Crawling stopped after the website restricted access, so this page was not requested." },
  SKIPPED: { label: "Skipped", tone: "neutral", description: "Excluded by robots.txt, off-site redirect, duplicate or non-HTML." },
};
