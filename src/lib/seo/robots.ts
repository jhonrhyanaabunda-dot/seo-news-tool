import "server-only";
import robotsParser from "robots-parser";
import { env } from "@/lib/env";
import type { RenderMode } from "@/lib/db/schema";
import { safeFetch } from "./fetcher";
import { browserRetryRaw } from "./browser-fetch";
import { planFetch } from "./render-policy";
import { detectBlock } from "./block-detect";
import { CRAWL_POLICY } from "./crawl-policy";
import { getCached, setCached } from "./site-cache";
import { canonicalHost } from "./url";

export interface RobotsInfo {
  found: boolean;
  url: string;
  status: number | null;
  content: string | null;
  sitemaps: string[];
  /** Our crawler is not allowed to fetch the homepage. */
  blocksMonitor: boolean;
  /** All user agents are blocked from the homepage (Disallow: /). */
  blocksAll: boolean;
  /** Googlebot is blocked from the homepage. */
  blocksGooglebot: boolean;
  crawlDelaySeconds: number | null;
  /** The request was refused by bot protection, so we don't know whether robots.txt exists. */
  blocked: boolean;
  /** Served from the per-host cache instead of a new request. */
  cached: boolean;
  error?: string;
  isAllowed: (url: string) => boolean;
}

export const CRAWLER_TOKEN = "A3SEOMonitor";

/** How old a previously read robots.txt may be and still stand in for one the site refused to serve. */
const STALE_ROBOTS_MAX_HOURS = 30 * 24;

type CachedRobots = { found: boolean; status: number | null; content: string | null; error?: string };

function build(siteUrl: string, c: CachedRobots, cached: boolean): RobotsInfo {
  const robotsUrl = new URL("/robots.txt", siteUrl).toString();
  const homepage = new URL("/", siteUrl).toString();
  const base = { url: robotsUrl, status: c.status, cached, blocked: false };
  if (!c.found || !c.content) {
    return { ...base, found: false, content: null, sitemaps: [], blocksMonitor: false, blocksAll: false, blocksGooglebot: false, crawlDelaySeconds: null, error: c.error, isAllowed: () => true };
  }
  const parser = robotsParser(robotsUrl, c.content);
  const allowedFor = (agent: string) => parser.isAllowed(homepage, agent) !== false;
  const delay = parser.getCrawlDelay(CRAWLER_TOKEN) ?? parser.getCrawlDelay(env().CRAWLER_USER_AGENT) ?? parser.getCrawlDelay("*") ?? null;
  return {
    ...base,
    found: true,
    content: c.content,
    // Spec requires absolute URLs, but relative ones are common; resolve them against the site.
    sitemaps: parser
      .getSitemaps()
      .map((s) => {
        try {
          return new URL(s, robotsUrl).toString();
        } catch {
          return null;
        }
      })
      .filter((s): s is string => s !== null && /^https?:\/\//i.test(s))
      .slice(0, 10),
    blocksMonitor: !allowedFor(CRAWLER_TOKEN),
    blocksAll: !allowedFor("*"),
    blocksGooglebot: !allowedFor("Googlebot"),
    crawlDelaySeconds: typeof delay === "number" && Number.isFinite(delay) ? Math.min(delay, 10) : null,
    isAllowed: (url: string) => parser.isAllowed(url, CRAWLER_TOKEN) !== false,
  };
}

export async function loadRobots(siteUrl: string, opts: { useCache?: boolean; renderMode?: RenderMode } = {}): Promise<RobotsInfo> {
  const host = canonicalHost(new URL(siteUrl).hostname);
  if (opts.useCache !== false) {
    const hit = await getCached<CachedRobots>(host, "robots", CRAWL_POLICY.robotsCacheHours);
    if (hit) return build(siteUrl, hit, true);
  }
  const robotsUrl = new URL("/robots.txt", siteUrl).toString();
  const fetchOpts = { maxBytes: 512 * 1024, retries: 1, accept: "text/plain,*/*;q=0.8" };
  let res = await safeFetch(robotsUrl, fetchOpts);
  // Sites that refuse the plain client (and serve the same crawler in a real
  // browser) would otherwise leave robots.txt unknown — and its rules unapplied.
  // Read it through the browser, same identity, no challenge solving.
  if (detectBlock(res).blocked && planFetch(opts.renderMode ?? "auto", env().BROWSER_RENDERING) !== "http-only") {
    const raw = await browserRetryRaw(robotsUrl, { ...fetchOpts, landOnTarget: true });
    if (raw && !detectBlock(raw).blocked) res = raw;
  }

  // Refused by bot protection: never cached, never reported as "missing". The last
  // copy actually read from this site (robots.txt rarely changes) is used when there
  // is one, so its rules still apply; otherwise the file is reported as unknown.
  if (detectBlock(res).blocked) {
    const lastKnown = await getCached<CachedRobots>(host, "robots", STALE_ROBOTS_MAX_HOURS);
    if (lastKnown?.found) return build(siteUrl, lastKnown, true);
    return { ...build(siteUrl, { found: false, status: res.status, content: null }, false), blocked: true, error: "Blocked by website security" };
  }
  // Missing or errored robots.txt → everything allowed (per RFC 9309 for 4xx).
  const looksValid = res.ok && res.body && !(res.contentType && !/text\/plain|text\/html|octet-stream/i.test(res.contentType) && !res.body.includes("User-agent"));
  const entry: CachedRobots = looksValid
    ? { found: true, status: res.status, content: res.body!.slice(0, 20000) }
    : { found: false, status: res.status, content: null, error: res.errorCode ? (res.errorMessage ?? res.errorCode) : res.status ? `HTTP ${res.status}` : undefined };
  // Cache definitive answers (found, or a real 4xx); don't cache timeouts/5xx.
  if (entry.found || (res.status !== null && res.status >= 400 && res.status < 500)) await setCached(host, "robots", entry);
  return build(siteUrl, entry, false);
}

/** Rebuild an allow-checker from stored robots.txt content (used when a scan resumes). */
export function robotsCheckerFromContent(baseUrl: string, content: string | null): (url: string) => boolean {
  if (!content) return () => true;
  const parser = robotsParser(new URL("/robots.txt", baseUrl).toString(), content);
  return (url: string) => parser.isAllowed(url, CRAWLER_TOKEN) !== false;
}
