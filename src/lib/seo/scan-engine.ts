import "server-only";
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  dealerships,
  scanLinks,
  scanPages,
  seoChecks,
  seoIssues,
  seoScans,
  type CrawlState,
  type Dealership,
  type NewScanPage,
  type RenderMode,
  type ScanChangeSummary,
  type ScanPage,
  type SeoScan,
  type SiteChecksSummary,
} from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { createAlert, createScanAlerts } from "@/lib/changes/alerts";
import { diffFingerprints, encodeFingerprint } from "@/lib/changes/detect";
import { safeFetch, type FetchResult } from "./fetcher";
import { browserCheckLinks, browserRetry } from "./browser-fetch";
import { planFetch } from "./render-policy";
import { parsePage, type ExtractedLink } from "./parser";
import { loadRobots, robotsCheckerFromContent } from "./robots";
import { loadSitemap } from "./sitemap";
import { getCached, setCached } from "./site-cache";
import { orderSitemapUrls, sitemapCandidates } from "./sitemap-seed";
import { detectPlatform } from "./platform";
import { classifyPageResult, isAnalyzed, isEmptyDocument, isProtected } from "./result-class";
import { crawlerLog, shortUrl } from "@/lib/crawler/log";
import { pageSpeedEnabled, runPageSpeed } from "./pagespeed";
import { detectBlock } from "./block-detect";
import { remoteAuditAvailable, runRemoteAudit } from "./remote-audit";
import { evaluateRemoteAudit } from "./checks/remote-evaluate";
import { evaluateScan, isOkHtmlPage, urlKey, type EvalPage } from "./checks/evaluate";
import { nextBlockState } from "./crawl-policy";
import { computeOutcome } from "./outcome";
import { computeScore } from "./scoring";
import { isUnverifiableHost } from "./checks/config";
import { isBrokenLink } from "./links";
import { IMPORTANT_PAGES, PAGE_TYPE_CAPS, classifyPath, isImportantType, isSameSite, looksLikeHtmlPage, normalizeUrl, pagePriority, requestUrl, canonicalHost, type PageType } from "./url";
import { logScanEvent } from "./scans";
import { sameWebsite } from "./site-identity";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Resumable SEO scan engine
 * ─────────────────────────────────────────────────────────────────────────────
 *  A scan is a small state machine persisted in Postgres:
 *
 *    init ──► crawl ──► links ──► finalize ──► completed
 *
 *  • init      robots.txt, homepage, sitemap; seeds the crawl frontier.
 *  • crawl     fetches pending `scan_pages` rows one at a time (polite,
 *              sequential per host) and discovers new internal links.
 *  • links     status-checks a deterministic sample of discovered links.
 *  • finalize  deterministic evaluation → score → change detection → alerts.
 *
 *  Each invocation works until its deadline and saves progress, so a scan
 *  can span several short serverless invocations (Vercel functions are
 *  capped at a few minutes). The same code runs unchanged in the optional
 *  long-running worker.
 */

const SAFETY_MS = 4000;
const PAGESPEED_CACHE_HOURS = 24;
const MAX_DEPTH = 4;
const MAX_INTERNAL_LINK_CHECKS = 150;
const MAX_EXTERNAL_LINK_CHECKS = 100;
const EXTERNAL_LINK_CONCURRENCY = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch a page. The crawler never tries to get around a website's security
 * controls: refusals (401/403/429/challenge pages) are not retried (see
 * crawl-policy) and are reported as "not evaluated".
 */
async function fetchPage(url: string, opts: Parameters<typeof safeFetch>[1], renderMode: RenderMode = "auto", siteRefusesPlain = false): Promise<FetchResult> {
  const res = await fetchPageOnce(url, opts, renderMode, siteRefusesPlain);
  // An interrupted browser render can come back as a 200 with an empty document; one more try usually gets the page.
  if (opts?.headersOnly || res.status === null || res.status < 200 || res.status >= 300 || !isEmptyDocument(res.body)) return res;
  await sleep(2000);
  return fetchPageOnce(url, opts, renderMode, siteRefusesPlain);
}

async function fetchPageOnce(url: string, opts: Parameters<typeof safeFetch>[1], renderMode: RenderMode, siteRefusesPlain: boolean): Promise<FetchResult> {
  const plan = planFetch(renderMode, env().BROWSER_RENDERING, { headersOnly: opts?.headersOnly });
  if (plan === "http-only") return safeFetch(url, opts);

  // Sites that serve nothing useful without JavaScript are rendered directly;
  // if no browser is available we still fall back to a plain request.
  // The same applies once this site has already refused a plain request in this scan and served the browser:
  // repeating a request it will refuse for every page only adds load on the site and seconds per page.
  if (plan === "browser-first" || siteRefusesPlain) {
    const rendered = await browserRetry(url, opts);
    return rendered ?? safeFetch(url, opts);
  }

  const res = await safeFetch(url, opts);
  if (!detectBlock(res).blocked) return res;

  // Refused by bot protection. Try once with a real browser, which runs the
  // JavaScript challenge the site expects. The crawler keeps its honest
  // A3SEOMonitor identity and robots.txt is still respected — this is a
  // different transport, not an attempt to disguise who is asking.
  const rendered = await browserRetry(url, opts);
  if (!rendered) return res;
  // Still refused: report the browser's refusal, so the page record shows that rendering was tried.
  return rendered;
}

function blockedMessage(state: CrawlState): string | null {
  if (state.blockedReason === "robots") return "robots.txt disallows the A3 SEO Monitor crawler, so pages could not be analysed. Add 'User-agent: A3SEOMonitor' with 'Allow: /' to robots.txt.";
  if (state.blockedReason === "firewall") {
    const remote = state.remoteAudit && !state.remoteAudit.error;
    return `This dealership website restricted automated access${state.blockVendor ? ` (${state.blockVendor})` : ""}. SEO results for inaccessible pages were not evaluated.${
      remote ? " A limited homepage check from an alternative source (Google PageSpeed Insights) is shown instead." : ""
    } Requires review: ask the website provider to allow-list the A3SEOMonitor crawler.`;
  }
  if (state.stoppedForBlock) {
    const s = state.stoppedForBlock;
    return `The website restricted automated access during the scan (${s.status ? `HTTP ${s.status}` : "security challenge"} at ${s.url}). Crawling stopped to avoid triggering further protection; the remaining pages were not evaluated and are not counted as SEO problems.`;
  }
  return null;
}

/** Thrown when an admin cancels a scan while it is running; unwinds the step (and any open transaction). */
class ScanCancelledError extends Error {
  constructor(scanId: number) {
    super(`Scan ${scanId} was cancelled`);
    this.name = "ScanCancelledError";
  }
}

const ACTIVE_STATUSES = ["queued", "crawling", "finalizing"] as const;

/**
 * Cancellation is a status change made by another process, so a running scan
 * re-reads it before every page and link batch. Without this a worker holding a
 * scan for a long step never noticed a cancel, and finalize then overwrote
 * "cancelled" with "completed".
 */
/**
 * Stop if the scan was cancelled; otherwise record that it is still progressing.
 * A worker can spend several minutes in one phase without saving state, and the
 * dashboard reads a quiet `updated_at` as a stalled scan.
 */
async function assertScanActive(scanId: number): Promise<void> {
  const [row] = await db
    .update(seoScans)
    .set({ updatedAt: new Date() })
    .where(and(eq(seoScans.id, scanId), inArray(seoScans.status, [...ACTIVE_STATUSES])))
    .returning({ id: seoScans.id });
  if (!row) throw new ScanCancelledError(scanId);
}

export async function runSeoScanStep(
  scanId: number,
  deadline: number,
  crawler: { region: string; id: string } = { region: "local", id: "local" },
): Promise<{ done: boolean; phase?: string; deferMs?: number }> {
  try {
    return await runStep(scanId, deadline, crawler);
  } catch (err) {
    if (!(err instanceof ScanCancelledError)) throw err;
    crawlerLog(`Cancelled: scan #${scanId} stopped`);
    return { done: true, phase: "cancelled" };
  }
}

async function runStep(scanId: number, deadline: number, crawler: { region: string; id: string }): Promise<{ done: boolean; phase?: string; deferMs?: number }> {
  const [scan] = await db.select().from(seoScans).where(eq(seoScans.id, scanId)).limit(1);
  if (!scan || scan.status === "completed" || scan.status === "failed" || scan.status === "cancelled") return { done: true };
  const [dealer] = await db.select().from(dealerships).where(eq(dealerships.id, scan.dealershipId)).limit(1);
  if (!dealer) throw new Error("The dealership for this scan no longer exists.");

  // Politeness: one active crawl per website. If another dealership shares this host and is being crawled, wait.
  const [busy] = await db
    .select({ id: seoScans.id })
    .from(seoScans)
    .innerJoin(dealerships, eq(dealerships.id, seoScans.dealershipId))
    .where(and(eq(dealerships.host, dealer.host), ne(seoScans.id, scanId), inArray(seoScans.status, ["crawling", "finalizing"]), sql`${seoScans.updatedAt} > now() - interval '15 minutes'`))
    .limit(1);
  if (busy) return { done: false, phase: "waiting", deferMs: 120_000 };

  let state = scan.crawlState;
  if (!state || state.phase === "init") {
    if (deadline - Date.now() < 45_000) return { done: false, phase: "init" };
    const started = await db
      .update(seoScans)
      .set({ status: "crawling", startedAt: scan.startedAt ?? new Date(), crawlerId: crawler.id.slice(0, 120), updatedAt: new Date() })
      .where(and(eq(seoScans.id, scanId), inArray(seoScans.status, ["queued", "crawling"])))
      .returning({ id: seoScans.id });
    if (!started.length) throw new ScanCancelledError(scanId);
    await logScanEvent(scanId, "info", `Scan started from crawler region ${crawler.region}`, { website: dealer.websiteUrl, crawler: crawler.id });
    state = await initPhase(scan, dealer);
    await saveState(scanId, state);
  }

  while (Date.now() < deadline - SAFETY_MS) {
    if (state.phase === "crawl") {
      const finished = await crawlPhase(scan, dealer, state, deadline);
      if (!finished) {
        await saveState(scanId, state);
        return { done: false, phase: "crawl" };
      }
      state.phase = "links";
      await saveState(scanId, state);
      await logScanEvent(scanId, "info", "Crawl finished; checking links");
    } else if (state.phase === "links") {
      const finished = await linksPhase(scan, dealer, state, deadline);
      await saveState(scanId, state);
      if (!finished) return { done: false, phase: "links" };
      state.phase = "finalize";
      const moved = await db
        .update(seoScans)
        .set({ status: "finalizing", crawlState: state, updatedAt: new Date() })
        .where(and(eq(seoScans.id, scanId), inArray(seoScans.status, ["crawling", "finalizing"])))
        .returning({ id: seoScans.id });
      if (!moved.length) throw new ScanCancelledError(scanId);
    } else if (state.phase === "finalize") {
      if (deadline - Date.now() < 20_000) return { done: false, phase: "finalize" };
      await finalizeScan(scan, dealer, state, deadline, crawler);
      return { done: true, phase: "completed" };
    } else {
      throw new Error(`Unknown scan phase ${state.phase}`);
    }
  }
  return { done: false, phase: state.phase };
}

async function saveState(scanId: number, state: CrawlState) {
  await db.update(seoScans).set({ crawlState: state, updatedAt: new Date() }).where(eq(seoScans.id, scanId));
}

/* ─────────────────────────────── init ─────────────────────────────── */

async function initPhase(scan: SeoScan, dealer: Dealership): Promise<CrawlState> {
  crawlerLog(`Dealership: ${dealer.name} (${dealer.websiteUrl}) — scan #${scan.id}`);
  const configured = new URL(dealer.websiteUrl);
  let baseUrl = new URL("/", configured).toString();
  let robots = await loadRobots(baseUrl, { renderMode: dealer.renderMode });

  const state: CrawlState = {
    phase: "crawl",
    baseUrl,
    robotsFound: robots.found,
    robotsContent: robots.content,
    robotsBlocksMonitor: robots.blocksMonitor,
    crawlDelayMs: Math.max(env().CRAWLER_DELAY_MS, (robots.crawlDelaySeconds ?? 0) * 1000),
    robotsBlockedCount: 0,
    sitemapUrlsSeeded: 0,
    homepageStatus: null,
    homepageErrorCode: null,
  };

  if (robots.blocksMonitor) {
    state.crawlBlocked = true;
    state.blockedReason = "robots";
    state.phase = "finalize";
    await logScanEvent(scan.id, "warn", "robots.txt disallows the A3 SEO Monitor crawler; only site-level checks were run.");
    await saveSiteChecks(scan.id, robots, null, null, state);
    return state;
  }

  const home = await fetchPage(dealer.websiteUrl, { htmlOnly: true, retries: 2 }, dealer.renderMode);
  state.homepageStatus = home.status;
  state.homepageErrorCode = home.errorCode;
  // Only a rendered page that got through counts: a browser that was also refused is reported as a block below.
  if (home.fetchMethod === "browser" && !detectBlock(home).blocked) {
    state.renderedWithBrowser = true;
    state.siteRefusesPlain = true;
    await logScanEvent(scan.id, "info", "A plain request was refused, so the homepage was read with a real browser (Chromium). The crawler identified itself as A3SEOMonitor throughout.");
  }

  // Bot protection refused us: the site is up for visitors, so this is not "website down".
  const block = detectBlock(home);
  if (block.blocked) {
    state.crawlBlocked = true;
    state.blockedReason = "firewall";
    state.blockVendor = block.vendor;
    state.phase = "finalize";
    // Record the refused URL, its HTTP status and the reason, for QA review.
    await db
      .insert(scanPages)
      .values({
        scanId: scan.id,
        dealershipId: dealer.id,
        url: dealer.websiteUrl,
        normalizedUrl: normalizeUrl(home.finalUrl || dealer.websiteUrl),
        depth: 0,
        priority: 0,
        status: "failed",
        pageType: "home",
        isImportant: true,
        httpStatus: home.status,
        finalUrl: home.finalUrl,
        errorCode: "BLOCKED",
        errorMessage: block.reason,
        fetchMethod: home.fetchMethod ?? "http",
        fetchedAt: new Date(),
      })
      .onConflictDoNothing();
    await logScanEvent(scan.id, "warn", `Website security restricted automated access: ${block.reason}. No retries will be made.`);
    await saveSiteChecks(scan.id, robots, null, home, state);
    // Fallback: a limited homepage check from Google's servers.
    if (remoteAuditAvailable()) {
      await logScanEvent(scan.id, "info", "Running a limited homepage check through Google PageSpeed Insights instead.");
      state.remoteAudit = await runRemoteAudit(dealer.websiteUrl);
      if (state.remoteAudit.error) await logScanEvent(scan.id, "warn", `Limited check not possible: ${state.remoteAudit.error}`);
      else await logScanEvent(scan.id, "info", "Limited homepage check completed via Google.");
    }
    return state;
  }

  // Follow a cross-host homepage redirect (e.g. domain change) and crawl the destination.
  if (home.finalUrl && !isSameSite(configured, new URL(home.finalUrl)) && home.ok) {
    baseUrl = new URL("/", home.finalUrl).toString();
    state.baseUrl = baseUrl;
    robots = await loadRobots(baseUrl, { renderMode: dealer.renderMode });
    state.robotsFound = robots.found;
    state.robotsContent = robots.content;
    state.robotsBlocksMonitor = robots.blocksMonitor;
    await logScanEvent(scan.id, "warn", `Homepage redirects to a different domain: ${home.finalUrl}`);
  }

  const available = home.ok && home.status !== null && home.status >= 200 && home.status < 300 && home.body !== null;
  const homeNormalized = normalizeUrl(home.finalUrl || dealer.websiteUrl);

  if (!available) {
    await db
      .insert(scanPages)
      .values({
        scanId: scan.id,
        dealershipId: dealer.id,
        url: dealer.websiteUrl,
        normalizedUrl: homeNormalized,
        depth: 0,
        priority: 0,
        status: home.status ? "fetched" : "failed",
        pageType: "home",
        isImportant: true,
        httpStatus: home.status,
        finalUrl: home.finalUrl,
        redirected: home.redirected,
        responseTimeMs: home.totalMs,
        errorCode: home.errorCode,
        errorMessage: home.errorMessage,
        fetchedAt: new Date(),
      })
      .onConflictDoNothing();
    await db.update(seoScans).set({ siteAvailable: false }).where(eq(seoScans.id, scan.id));
    await saveSiteChecks(scan.id, robots, null, home, state);
    await logScanEvent(scan.id, "error", "Homepage could not be loaded", { status: home.status, error: home.errorCode });
    state.phase = "finalize";
    return state;
  }

  await db.update(seoScans).set({ siteAvailable: true }).where(eq(seoScans.id, scan.id));
  // Platform from the markup already downloaded — no extra request.
  const platform = detectPlatform(home.body);
  if (platform && platform !== dealer.detectedPlatform) {
    await db.update(dealerships).set({ detectedPlatform: platform }).where(eq(dealerships.id, dealer.id));
    crawlerLog(`Platform detected: ${platform}`);
  }
  const [homeRow] = await db
    .insert(scanPages)
    .values({
      scanId: scan.id,
      dealershipId: dealer.id,
      url: home.finalUrl,
      normalizedUrl: homeNormalized,
      depth: 0,
      priority: 0,
      status: "pending",
      pageType: "home",
      isImportant: true,
    })
    .onConflictDoNothing()
    .returning();

  const sitemap = await loadSitemap(baseUrl, sitemapCandidates(dealer.sitemapUrl, robots.sitemaps), { renderMode: dealer.renderMode, preferredUrl: dealer.sitemapUrl });
  await saveSiteChecks(scan.id, robots, sitemap, home, state);

  // The context must see the new crawl state (base URL, robots rules), not the pre-init scan row.
  const scanWithState: SeoScan = { ...scan, crawlState: state };
  const ctx = await loadCrawlContext(scanWithState);

  // Sitemap first: the URLs the site itself declares take the page budget, most important dealership pages first.
  // Links found on the homepage (processed next) only fill whatever budget is left — or everything, with no sitemap.
  if (sitemap.urls.length) {
    const links: ExtractedLink[] = orderSitemapUrls(sitemap.urls).map((u) => ({ url: u.toString(), normalized: normalizeUrl(u), isInternal: true, anchor: "", nofollow: false }));
    state.sitemapUrlsSeeded = await enqueueLinks(scanWithState, state, ctx, links, 1, "sitemap");
  }
  crawlerLog(
    sitemap.found
      ? `Sitemap discovered: ${sitemap.urlCount} URLs${sitemap.cached ? " (cached)" : ""}; ${state.sitemapUrlsSeeded} queued`
      : sitemap.blocked
        ? "Sitemap request was refused by website security; using links from the homepage"
        : "No sitemap found; using links from the homepage",
  );
  if (homeRow) await processPageResult(scanWithState, state, ctx, homeRow, home);
  await logScanEvent(scan.id, "info", "Site checks complete", {
    robotsTxt: robots.found,
    robotsFromCache: robots.cached,
    sitemap: sitemap.found,
    sitemapFromCache: Boolean(sitemap.cached),
    sitemapBlocked: Boolean(sitemap.blocked),
    sitemapUrls: sitemap.urlCount,
    seededFromSitemap: state.sitemapUrlsSeeded,
  });
  return state;
}

async function saveSiteChecks(
  scanId: number,
  robots: Awaited<ReturnType<typeof loadRobots>>,
  sitemap: Awaited<ReturnType<typeof loadSitemap>> | null,
  home: FetchResult | null,
  state: CrawlState,
) {
  const siteChecks: SiteChecksSummary = {
    robotsTxt: {
      found: robots.found,
      url: robots.url,
      blocksAll: robots.blocksAll,
      blocksGooglebot: robots.blocksGooglebot,
      blocksMonitor: robots.blocksMonitor,
      sitemaps: robots.sitemaps,
      error: robots.error,
      blocked: robots.blocked,
    },
    sitemap: sitemap ? { found: sitemap.found, url: sitemap.url, urlCount: sitemap.urlCount, error: sitemap.error, blocked: sitemap.blocked } : { found: false, url: null, urlCount: 0 },
    homepageStatus: home?.status ?? null,
    homepageHttps: home ? home.finalUrl.startsWith("https:") : false,
    importantPages: [],
    brokenInternalLinks: 0,
    brokenExternalLinks: 0,
    linksChecked: 0,
    duplicateTitles: 0,
    duplicateDescriptions: 0,
    avgResponseMs: null,
    crawlBlocked: Boolean(state.crawlBlocked),
    blockedReason: state.blockedReason ?? null,
    blockVendor: state.blockVendor ?? null,
  };
  await db.update(seoScans).set({ siteChecks }).where(eq(seoScans.id, scanId));
}

/* ─────────────────────────────── crawl ────────────────────────────── */

interface CrawlContext {
  known: Set<string>;
  total: number;
  byType: Map<string, number>;
  isAllowed: (url: string) => boolean;
  base: URL;
}

async function loadCrawlContext(scan: SeoScan): Promise<CrawlContext> {
  const rows = await db
    .select({ normalizedUrl: scanPages.normalizedUrl, pageType: scanPages.pageType, status: scanPages.status })
    .from(scanPages)
    .where(eq(scanPages.scanId, scan.id));
  const byType = new Map<string, number>();
  let total = 0;
  for (const r of rows) {
    if (r.status === "skipped") continue;
    total++;
    if (r.pageType) byType.set(r.pageType, (byType.get(r.pageType) ?? 0) + 1);
  }
  const state = scan.crawlState;
  return {
    known: new Set(rows.map((r) => r.normalizedUrl)),
    total,
    byType,
    isAllowed: robotsCheckerFromContent(state?.baseUrl ?? "https://invalid.example/", state?.robotsContent ?? null),
    base: new URL(state?.baseUrl ?? "https://invalid.example/"),
  };
}

async function crawlPhase(scan: SeoScan, dealer: Dealership, state: CrawlState, deadline: number): Promise<boolean> {
  const fresh = { ...scan, crawlState: state };
  const ctx = await loadCrawlContext(fresh);
  const timeout = env().CRAWLER_TIMEOUT_MS;
  while (Date.now() + timeout + state.crawlDelayMs + SAFETY_MS < deadline) {
    await assertScanActive(scan.id);
    const [next] = await db
      .select()
      .from(scanPages)
      .where(and(eq(scanPages.scanId, scan.id), eq(scanPages.status, "pending")))
      .orderBy(asc(scanPages.priority), asc(scanPages.depth), asc(scanPages.id))
      .limit(1);
    if (!next) return true;
    if (!ctx.isAllowed(next.url)) {
      await db.update(scanPages).set({ status: "skipped", errorCode: "ROBOTS_BLOCKED" }).where(eq(scanPages.id, next.id));
      state.robotsBlockedCount++;
      ctx.total--;
      continue;
    }
    await sleep(state.crawlDelayMs);
    state.pagesRequested = (state.pagesRequested ?? 1) + 1; // the homepage was request 1
    crawlerLog(`Crawling URL ${state.pagesRequested}/${ctx.total} ${shortUrl(next.url)}`);
    const res = await fetchPage(next.url, { htmlOnly: true, sameSiteOnly: true, retries: 1 }, dealer.renderMode, Boolean(state.siteRefusesPlain));
    if (res.fetchMethod === "browser" && !detectBlock(res).blocked) {
      state.renderedWithBrowser = true;
      state.siteRefusesPlain = true;
    }
    const r = await processPageResult(fresh, state, ctx, next, res);
    if (r.blocked) crawlerLog(`Protected: ${shortUrl(next.url)} (${r.reason ?? `HTTP ${r.status}`})`);
    // Stop crawling this site after repeated refusals or any rate-limit response.
    const verdict = nextBlockState(state.blockStreak ?? 0, { status: r.status, blocked: r.blocked });
    state.blockStreak = verdict.streak;
    if (verdict.stop) {
      state.stoppedForBlock = { url: next.url, status: r.status, reason: r.reason ?? (verdict.rateLimited ? "Rate limited (HTTP 429)" : "Access restricted") };
      const rest = await db
        .update(scanPages)
        .set({ status: "skipped", errorCode: "NOT_EVALUATED", errorMessage: "Not evaluated: crawling stopped after the website restricted automated access." })
        .where(and(eq(scanPages.scanId, scan.id), eq(scanPages.status, "pending")))
        .returning({ id: scanPages.id });
      await logScanEvent(
        scan.id,
        "warn",
        `The website restricted automated access (${r.status ? `HTTP ${r.status}` : "security challenge"}) at ${next.url}. Crawling stopped to avoid triggering further protection; ${rest.length} remaining page(s) were not evaluated.`,
      );
      return true;
    }
  }
  return false;
}

async function processPageResult(
  scan: SeoScan,
  state: CrawlState,
  ctx: CrawlContext,
  row: ScanPage,
  res: FetchResult,
): Promise<{ blocked: boolean; status: number | null; reason?: string }> {
  const now = new Date();
  const ok = { blocked: false, status: res.status };
  if (res.errorCode === "REDIRECT_OFFSITE" || res.errorCode === "NOT_HTML" || res.errorCode === "UNSAFE_URL") {
    await db
      .update(scanPages)
      .set({ status: "skipped", httpStatus: res.status, finalUrl: res.finalUrl, errorCode: res.errorCode, errorMessage: res.errorMessage, fetchedAt: now })
      .where(eq(scanPages.id, row.id));
    ctx.total--;
    return ok;
  }

  // Enforce the same-site rule for the final URL.
  if (row.pageType !== "home" && res.finalUrl) {
    let offsite = false;
    try {
      offsite = !isSameSite(ctx.base, new URL(res.finalUrl));
    } catch {
      offsite = true;
    }
    if (offsite) {
      await db.update(scanPages).set({ status: "skipped", finalUrl: res.finalUrl, errorCode: "REDIRECT_OFFSITE", fetchedAt: now }).where(eq(scanPages.id, row.id));
      ctx.total--;
      return ok;
    }
  }

  const block = detectBlock(res);
  if (block.blocked) {
    await db
      .update(scanPages)
      .set({ status: "failed", httpStatus: res.status, finalUrl: res.finalUrl, errorCode: "BLOCKED", errorMessage: block.reason, fetchMethod: res.fetchMethod, fetchedAt: now })
      .where(eq(scanPages.id, row.id));
    return { blocked: true, status: res.status, reason: block.reason ?? "Access restricted" };
  }

  // Redirected to a URL we already have → treat as duplicate, not a separate page.
  let normalizedFinal = row.normalizedUrl;
  if (res.redirected && res.finalUrl) {
    try {
      normalizedFinal = normalizeUrl(res.finalUrl);
    } catch {
      /* keep */
    }
    if (normalizedFinal !== row.normalizedUrl) {
      if (ctx.known.has(normalizedFinal)) {
        await db
          .update(scanPages)
          .set({ status: "skipped", httpStatus: res.status, finalUrl: res.finalUrl, redirected: true, errorCode: "DUPLICATE", fetchedAt: now })
          .where(eq(scanPages.id, row.id));
        ctx.total--;
        return ok;
      }
      ctx.known.add(normalizedFinal);
    }
  }

  const finalUrl = res.finalUrl || row.url;
  const pageType = row.pageType === "home" ? "home" : classifyPath(new URL(finalUrl));
  const base: Partial<NewScanPage> = {
    normalizedUrl: normalizedFinal,
    httpStatus: res.status,
    finalUrl,
    redirected: res.redirected,
    // For browser fetches this is the server's own document timing, not the
    // render time, so "slow response" keeps measuring the site rather than us.
    responseTimeMs: res.serverResponseMs ?? res.totalMs,
    ttfbMs: res.ttfbMs,
    contentType: res.contentType?.slice(0, 120) ?? null,
    fetchMethod: res.fetchMethod ?? "http",
    xRobotsTag: res.headers["x-robots-tag"]?.slice(0, 200) ?? null,
    pageType,
    isImportant: row.isImportant || isImportantType(pageType as PageType),
    fetchedAt: now,
  };

  if (res.status === null) {
    await db
      .update(scanPages)
      .set({ ...base, status: "failed", errorCode: res.errorCode, errorMessage: res.errorMessage })
      .where(eq(scanPages.id, row.id));
    return ok;
  }
  if (res.status < 200 || res.status >= 300 || res.body === null) {
    await db
      .update(scanPages)
      .set({ ...base, status: "fetched", errorCode: res.errorCode ?? "HTTP_ERROR", errorMessage: res.errorMessage })
      .where(eq(scanPages.id, row.id));
    return ok;
  }

  if (isEmptyDocument(res.body)) {
    await db
      .update(scanPages)
      .set({ ...base, status: "failed", errorCode: "EMPTY_RESPONSE", errorMessage: "The page came back as an empty document twice, so it was not analysed (not counted as an SEO issue)." })
      .where(eq(scanPages.id, row.id));
    return ok;
  }

  const parsed = parsePage(res.body, finalUrl);
  const noindex = /noindex/i.test(parsed.robotsMeta ?? "") || /noindex/i.test(res.headers["x-robots-tag"] ?? "");
  await db
    .update(scanPages)
    .set({
      ...base,
      status: "fetched",
      htmlBytes: res.bytes,
      title: parsed.title,
      metaDescription: parsed.metaDescription,
      h1: parsed.h1,
      h2: parsed.h2,
      canonical: parsed.canonical?.slice(0, 2000) ?? null,
      robotsMeta: parsed.robotsMeta,
      indexable: !noindex,
      lang: parsed.lang,
      hasViewport: parsed.hasViewport,
      wordCount: parsed.wordCount,
      internalLinksCount: parsed.internalLinksCount,
      externalLinksCount: parsed.externalLinksCount,
      imagesCount: parsed.imagesCount,
      imagesMissingAlt: parsed.imagesMissingAlt,
      scriptsCount: parsed.scriptsCount,
      blockingScriptsCount: parsed.blockingScriptsCount,
      stylesheetsCount: parsed.stylesheetsCount,
      schemaTypes: parsed.schemaTypes,
      schemaErrors: parsed.schemaErrors,
      openGraph: parsed.openGraph,
      details: {
        imagesMissingAltSamples: parsed.imagesMissingAltSamples,
        imagesWithoutDimensions: parsed.imagesWithoutDimensions,
        mixedContentCount: parsed.mixedContentCount,
        redirectChain: res.redirectChain.slice(0, 5),
        twitterCard: parsed.twitterCard,
        truncated: res.truncated,
        clientRedirect: parsed.clientRedirect,
      },
    })
    .where(eq(scanPages.id, row.id));

  await recordLinks(scan.id, finalUrl, parsed.links);
  if (row.depth < MAX_DEPTH) {
    const follow = parsed.links.filter((l) => l.isInternal && !l.nofollow);
    // Follow a same-site client-side redirect so the destination page is still analysed.
    if (parsed.clientRedirect) {
      try {
        const target = new URL(parsed.clientRedirect.target);
        if (isSameSite(ctx.base, target)) follow.unshift({ url: target.toString(), normalized: normalizeUrl(target), isInternal: true, anchor: "", nofollow: false });
      } catch {
        /* ignore malformed target */
      }
    }
    await enqueueLinks(scan, state, ctx, follow, row.depth + 1, row.pageType === "home" ? "nav" : "link");
  }
  return ok;
}

/** A site that links both /page and /page/ has one broken target, not two: keep the most-linked form. */
function oneRowPerTarget<T extends { url: string; occurrences: number }>(rows: T[]): T[] {
  const best = new Map<string, T>();
  for (const r of rows) {
    let key = r.url;
    try {
      key = normalizeUrl(r.url);
    } catch {
      /* keep the raw URL as its own key */
    }
    const cur = best.get(key);
    if (!cur || r.occurrences > cur.occurrences) best.set(key, r);
  }
  return [...best.values()];
}

async function recordLinks(scanId: number, pageUrl: string, links: ExtractedLink[]) {
  const rows = links.map((l) => ({
    scanId,
    // Checked exactly as the site links it: stripping the trailing slash asked for an address the site never
    // links to, and sites that serve /page/ often answer /page with a 404 (reported as a broken link that isn't).
    url: requestUrl(l.url).slice(0, 2000),
    isInternal: l.isInternal,
    foundOn: [pageUrl.slice(0, 2000)],
    anchorText: l.anchor.slice(0, 300) || null,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    await db
      .insert(scanLinks)
      .values(rows.slice(i, i + 200))
      .onConflictDoUpdate({
        target: [scanLinks.scanId, scanLinks.url],
        set: {
          occurrences: sql`${scanLinks.occurrences} + 1`,
          foundOn: sql`case when jsonb_array_length(${scanLinks.foundOn}) < 5 then ${scanLinks.foundOn} || excluded.found_on else ${scanLinks.foundOn} end`,
          anchorText: sql`coalesce(${scanLinks.anchorText}, excluded.anchor_text)`,
        },
      });
  }
}

/** Add discovered internal URLs to the frontier, respecting caps and robots.txt. */
async function enqueueLinks(
  scan: SeoScan,
  state: CrawlState,
  ctx: CrawlContext,
  links: ExtractedLink[],
  depth: number,
  source: "nav" | "link" | "sitemap",
  limit?: number,
): Promise<number> {
  const values: NewScanPage[] = [];
  for (const l of links) {
    if (ctx.total >= scan.maxPages || (limit !== undefined && values.length >= limit)) break;
    if (ctx.known.has(l.normalized)) continue;
    let url: URL;
    try {
      // Request the URL in the site's own form; `normalized` is only the de-duplication key.
      url = new URL(requestUrl(l.url));
    } catch {
      continue;
    }
    if (!isSameSite(ctx.base, url) || !looksLikeHtmlPage(url)) continue;
    if (!ctx.isAllowed(url.toString())) {
      ctx.known.add(l.normalized);
      state.robotsBlockedCount++;
      continue;
    }
    const type = classifyPath(url);
    const cap = PAGE_TYPE_CAPS[type];
    if (cap !== undefined && (ctx.byType.get(type) ?? 0) >= cap) continue;
    const navImportant = IMPORTANT_PAGES.some((p) => p.anchorPatterns.test(l.anchor));
    const important = isImportantType(type) || navImportant;
    values.push({
      scanId: scan.id,
      dealershipId: scan.dealershipId,
      url: url.toString().slice(0, 2000),
      normalizedUrl: l.normalized.slice(0, 2000),
      depth,
      priority: pagePriority(type, { depth, fromSitemap: source === "sitemap", navLinked: source === "nav" || navImportant }),
      status: "pending",
      pageType: type,
      isImportant: important && type !== "other",
    });
    ctx.known.add(l.normalized);
    ctx.total++;
    ctx.byType.set(type, (ctx.byType.get(type) ?? 0) + 1);
  }
  if (!values.length) return 0;
  const inserted = await db.insert(scanPages).values(values).onConflictDoNothing().returning({ id: scanPages.id });
  return inserted.length;
}

/* ─────────────────────────────── links ────────────────────────────── */

async function linksPhase(scan: SeoScan, dealer: Dealership, state: CrawlState, deadline: number): Promise<boolean> {
  // Refused internal link checks can be re-checked through the browser session the site already admitted.
  const canRender = planFetch(dealer.renderMode, env().BROWSER_RENDERING) !== "http-only";
  if (!state.linksPrepared) {
    // Targets we already crawled inherit the page's result — no second request.
    await db.execute(sql`
      update ${scanLinks} l set
        checked = true,
        http_status = p.http_status,
        error_code = p.error_code,
        is_broken = (p.http_status in (404, 410) or p.http_status >= 500)
          or (p.http_status is null and p.error_code in ('TIMEOUT','DNS','CONNECTION','TLS','TOO_MANY_REDIRECTS'))
      from ${scanPages} p
      where l.scan_id = ${scan.id} and p.scan_id = ${scan.id}
        and p.normalized_url = l.url and l.checked = false and p.status in ('fetched', 'failed')
    `);
    const pick = async (internal: boolean, limit: number) =>
      db
        .select({ id: scanLinks.id })
        .from(scanLinks)
        .where(and(eq(scanLinks.scanId, scan.id), eq(scanLinks.checked, false), eq(scanLinks.isInternal, internal)))
        .orderBy(desc(scanLinks.occurrences), asc(scanLinks.url))
        .limit(limit);
    // If the site already restricted the crawler, don't send it more requests for link checks.
    const internal = state.stoppedForBlock ? [] : await pick(true, MAX_INTERNAL_LINK_CHECKS);
    const external = await pick(false, MAX_EXTERNAL_LINK_CHECKS);
    state.linkQueue = [...internal.map((r) => r.id), ...external.map((r) => r.id)];
    state.linksPrepared = true;
    await saveState(scan.id, state);
  }

  const isAllowed = robotsCheckerFromContent(state.baseUrl, state.robotsContent);
  const timeout = 10_000;
  while ((state.linkQueue?.length ?? 0) > 0) {
    if (Date.now() + timeout + SAFETY_MS > deadline) return false;
    await assertScanActive(scan.id);
    const batchIds = state.linkQueue!.slice(0, EXTERNAL_LINK_CONCURRENCY);
    const rows = await db.select().from(scanLinks).where(inArray(scanLinks.id, batchIds));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const first = byId.get(batchIds[0]);
    // Internal links: one at a time with the politeness delay. External: small parallel batch, never two requests to the same host.
    let batch: number[];
    if (first?.isInternal) batch = [batchIds[0]];
    else {
      const hosts = new Set<string>();
      batch = [];
      for (const id of batchIds) {
        const r = byId.get(id);
        if (!r || r.isInternal) continue;
        let h = "";
        try {
          h = new URL(r.url).hostname;
        } catch {
          /* ignore */
        }
        if (hosts.has(h)) continue;
        hosts.add(h);
        batch.push(id);
      }
    }
    let stopInternal = false;
    await Promise.all(
      batch.map(async (id) => {
        const link = byId.get(id);
        if (!link) return;
        let host = "";
        try {
          host = new URL(link.url).hostname;
        } catch {
          /* ignore */
        }
        if (!link.isInternal && isUnverifiableHost(host)) {
          await db.update(scanLinks).set({ checked: true, errorCode: "UNVERIFIABLE" }).where(eq(scanLinks.id, id));
          return;
        }
        if (link.isInternal && !isAllowed(link.url)) {
          await db.update(scanLinks).set({ checked: true, errorCode: "ROBOTS_BLOCKED" }).where(eq(scanLinks.id, id));
          return;
        }
        if (link.isInternal) await sleep(Math.round(state.crawlDelayMs / 2));
        const res = await safeFetch(link.url, { headersOnly: true, timeoutMs: timeout, retries: link.isInternal ? 1 : 0 });
        const refused = res.status === 401 || res.status === 403 || res.status === 429;
        if (link.isInternal) {
          const v = nextBlockState(state.blockStreak ?? 0, { status: res.status, blocked: refused });
          state.blockStreak = v.streak;
          if (v.stop) stopInternal = true;
        }
        await db
          .update(scanLinks)
          .set({ checked: true, httpStatus: res.status, errorCode: refused ? "UNVERIFIABLE" : res.errorCode, isBroken: isBrokenLink(link.isInternal, res.status, res.errorCode) })
          .where(eq(scanLinks.id, id));
        if (refused && link.isInternal && canRender) (state.browserLinkQueue ??= []).push(id);
      }),
    );
    const done = new Set(batch.length ? batch : batchIds.slice(0, 1));
    state.linkQueue = state.linkQueue!.filter((id) => !done.has(id));
    if (stopInternal && state.linkQueue.length) {
      const internalLeft = await db
        .select({ id: scanLinks.id })
        .from(scanLinks)
        .where(and(inArray(scanLinks.id, state.linkQueue), eq(scanLinks.isInternal, true)));
      const drop = new Set(internalLeft.map((r) => r.id));
      state.linkQueue = state.linkQueue.filter((id) => !drop.has(id));
      if (canRender) {
        // No more plain requests to a site that refused them; the browser session re-checks these instead.
        (state.browserLinkQueue ??= []).push(...drop);
        await logScanEvent(scan.id, "info", `The website refused plain internal link checks; ${drop.size} remaining internal link(s) will be checked through the browser session instead.`);
      } else {
        await logScanEvent(scan.id, "warn", `The website refused internal link checks; ${drop.size} remaining internal link check(s) were skipped to avoid triggering further protection.`);
      }
    }
    await saveState(scan.id, state);
  }
  return browserLinkChecks(scan, state, deadline);
}

/**
 * Minimum time left in a step before a browser link-check batch is started: a full page load plus a few checks.
 * Kept above browserCheckLinks' own threshold so a short step defers here instead of counting as a stall.
 */
const browserLinkBatchMinMs = () => env().BROWSER_TIMEOUT_MS + 20_000;
const BROWSER_LINK_BATCH_SIZE = 40;

/**
 * Re-check, through the browser session, the internal links the plain client
 * was refused on. Resumable across steps: the queue lives in the crawl state.
 * Links still unverifiable afterwards stay marked UNVERIFIABLE, not broken.
 */
async function browserLinkChecks(scan: SeoScan, state: CrawlState, deadline: number): Promise<boolean> {
  let verified = 0;
  let unverifiable = 0;
  let broken = 0;
  while ((state.browserLinkQueue?.length ?? 0) > 0) {
    if (deadline - Date.now() - SAFETY_MS < browserLinkBatchMinMs()) return false;
    await assertScanActive(scan.id);
    const batchIds = state.browserLinkQueue!.slice(0, BROWSER_LINK_BATCH_SIZE);
    const rows = await db.select({ id: scanLinks.id, url: scanLinks.url }).from(scanLinks).where(inArray(scanLinks.id, batchIds));
    const idByUrl = new Map(rows.map((r) => [r.url, r.id]));
    const out = await browserCheckLinks(
      rows.map((r) => r.url),
      { delayMs: Math.round(state.crawlDelayMs / 2), deadline: deadline - SAFETY_MS, isActive: () => assertScanActive(scan.id).then(() => true, () => false) },
    );
    if (!out) {
      await logScanEvent(scan.id, "warn", `${state.browserLinkQueue!.length} internal link(s) could not be verified: no browser is available in this environment.`);
      state.browserLinkQueue = [];
      break;
    }
    for (const c of out.checked) {
      const id = idByUrl.get(c.url);
      if (id === undefined || c.refused) continue;
      const isBroken = isBrokenLink(true, c.status, c.errorCode);
      await db.update(scanLinks).set({ checked: true, httpStatus: c.status, errorCode: c.errorCode, isBroken }).where(eq(scanLinks.id, id));
      if (c.errorCode === "UNVERIFIABLE") unverifiable++;
      else verified++;
      if (isBroken) broken++;
    }
    const done = new Set(out.checked.map((c) => idByUrl.get(c.url)));
    // Ids with no matching row (deleted) are done too, or the queue would never drain.
    const missing = new Set(batchIds.filter((id) => !rows.some((r) => r.id === id)));
    state.browserLinkQueue = state.browserLinkQueue!.filter((id) => !done.has(id) && !missing.has(id));
    if (out.stopped === "cancelled") throw new ScanCancelledError(scan.id);
    if (out.stopped === "refused" || out.stopped === "error") {
      // Final for this scan: never retried, so a refusal or a fault cannot become repeated visits to the site.
      const why = out.stopped === "refused" ? "the website also refused link checks from the browser session" : "browser link checking failed";
      await logScanEvent(scan.id, "warn", `${why[0].toUpperCase()}${why.slice(1)}; ${state.browserLinkQueue.length} internal link(s) remain unverified and are not counted as broken.`);
      state.browserLinkQueue = [];
    } else if (out.stopped === "deadline") {
      // Out of time in this step. Resume next step — but only a bounded number of times without progress.
      state.browserLinkStalls = out.checked.length ? 0 : (state.browserLinkStalls ?? 0) + 1;
      if ((state.browserLinkStalls ?? 0) >= 3) {
        await logScanEvent(scan.id, "warn", `Browser link checks made no progress in 3 attempts; ${state.browserLinkQueue.length} internal link(s) remain unverified.`);
        state.browserLinkQueue = [];
      } else {
        await saveState(scan.id, state);
        return false;
      }
    }
    await saveState(scan.id, state);
  }
  if (verified || unverifiable) {
    await logScanEvent(
      scan.id,
      "info",
      `Checked ${verified} internal link(s) through the browser session after plain requests were refused; ${broken} broken.${unverifiable ? ` ${unverifiable} could not be verified from the browser and are not counted as broken.` : ""}`,
    );
  }
  return true;
}

/* ───────────────────────────── finalize ───────────────────────────── */

async function finalizeScan(scan: SeoScan, dealer: Dealership, state: CrawlState, deadline: number, crawler: { region: string; id: string }) {
  const settings = await getSettings();
  const [current] = await db.select().from(seoScans).where(eq(seoScans.id, scan.id)).limit(1);
  const siteChecks = (current?.siteChecks ?? null) as SiteChecksSummary | null;
  const crawlBlocked = Boolean(state.crawlBlocked);
  const siteAvailable = crawlBlocked ? true : state.homepageStatus !== null && state.homepageStatus !== undefined && state.homepageStatus >= 200 && state.homepageStatus < 300;

  const pages = await db.select().from(scanPages).where(eq(scanPages.scanId, scan.id)).orderBy(asc(scanPages.id));
  const brokenLinks = oneRowPerTarget(await db.select().from(scanLinks).where(and(eq(scanLinks.scanId, scan.id), eq(scanLinks.isBroken, true))));
  const [linkStats] = await db
    .select({
      checked: sql<number>`count(*) filter (where ${scanLinks.checked} and ${scanLinks.errorCode} is distinct from 'UNVERIFIABLE')::int`,
    })
    .from(scanLinks)
    .where(eq(scanLinks.scanId, scan.id));

  // Key dealership pages: found if crawled, or linked with a recognisable URL/anchor.
  let importantPages: SiteChecksSummary["importantPages"] = [];
  if (siteAvailable && !crawlBlocked) {
    const internalLinks = await db
      .select({ url: scanLinks.url, anchor: scanLinks.anchorText })
      .from(scanLinks)
      .where(and(eq(scanLinks.scanId, scan.id), eq(scanLinks.isInternal, true)))
      .orderBy(desc(scanLinks.occurrences), asc(scanLinks.url))
      .limit(5000);
    const okPages = pages.filter((p) => p.status === "fetched" && p.httpStatus !== null && p.httpStatus < 400);
    importantPages = IMPORTANT_PAGES.map((def) => {
      const page = okPages.find((p) => p.pageType && def.pageTypes.includes(p.pageType as PageType));
      if (page) return { key: def.key, label: def.label, found: true, url: page.finalUrl ?? page.url };
      const link = internalLinks.find((l) => {
        try {
          return def.pageTypes.includes(classifyPath(new URL(l.url))) || (l.anchor ? def.anchorPatterns.test(l.anchor) : false);
        } catch {
          return false;
        }
      });
      return { key: def.key, label: def.label, found: Boolean(link), url: link?.url ?? null };
    });
  }

  // Optional real-browser performance metrics from Google's infrastructure (not scored).
  await assertScanActive(scan.id);
  let pagespeed: SiteChecksSummary["pagespeed"] = null;
  if (pageSpeedEnabled() && siteAvailable && !crawlBlocked) {
    // Lighthouse lab metrics take ~40-60 s from Google and are context only (not scored), so one result per site per day is reused.
    const psHost = canonicalHost(new URL(state.baseUrl).hostname);
    pagespeed = await getCached<NonNullable<SiteChecksSummary["pagespeed"]>>(psHost, "pagespeed", PAGESPEED_CACHE_HOURS);
    if (!pagespeed && deadline - Date.now() > 80_000) {
      pagespeed = await runPageSpeed(state.baseUrl, "mobile", 60_000);
      if (!pagespeed.error) await setCached(psHost, "pagespeed", pagespeed);
    }
  }

  const evalPages: EvalPage[] = pages.map((p) => ({ ...p }));
  const remote = state.remoteAudit && !state.remoteAudit.error ? state.remoteAudit : null;
  if (remote?.performance) pagespeed = remote.performance;
  const evaluation = remote ? evaluateRemoteAudit(remote) : evaluateScan(
    crawlBlocked ? [] : evalPages,
    brokenLinks.map((l) => ({ ...l, foundOn: l.foundOn ?? [] })),
    {
      baseUrl: state.baseUrl,
      siteAvailable,
      homepageStatus: state.homepageStatus ?? null,
      homepageErrorCode: state.homepageErrorCode ?? null,
      robots: {
        found: siteChecks?.robotsTxt.found ?? state.robotsFound,
        blocksAll: siteChecks?.robotsTxt.blocksAll ?? false,
        blocksGooglebot: siteChecks?.robotsTxt.blocksGooglebot ?? false,
        sitemaps: siteChecks?.robotsTxt.sitemaps ?? [],
        checked: !siteChecks?.robotsTxt.blocked,
      },
      // Unknown (not "missing") when the crawl or the sitemap request was refused.
      sitemap: crawlBlocked || siteChecks?.sitemap.blocked ? null : { found: siteChecks?.sitemap.found ?? false, urlCount: siteChecks?.sitemap.urlCount ?? 0 },
      importantPages,
    },
  );
  const scored = computeScore(evaluation.checks);
  const score = siteAvailable && !crawlBlocked ? scored.score : null;
  const fingerprints = evaluation.issues.map((i) => encodeFingerprint(i.severity, i.fingerprint)).sort();

  // Change detection against the previous comparable scan.
  // Only scans of the same website are comparable (the dealership's address may have changed).
  const thisScan = { websiteUrl: current?.websiteUrl ?? dealer.websiteUrl, crawlState: state };
  const recent = await db
    .select()
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealer.id), eq(seoScans.status, "completed"), ne(seoScans.id, scan.id)))
    .orderBy(desc(seoScans.completedAt))
    .limit(50);
  const sameSite = recent.filter((s) => sameWebsite(s, thisScan));
  const previousAny = sameSite[0];
  // Scans that could not evaluate every page are not valid baselines.
  const baseline = sameSite.find((s) => s.siteAvailable === true && s.issueFingerprints !== null && s.score !== null && s.outcome !== "blocked" && s.outcome !== "partially_blocked");

  // Access & coverage: pages refused by the site, pages skipped after crawling stopped, other failures.
  const pagesBlocked = pages.filter((p) => p.errorCode === "BLOCKED").length;
  const pagesNotEvaluated = pages.filter((p) => p.errorCode === "NOT_EVALUATED").length;
  const pagesFailedOther = pages.filter((p) => p.errorCode !== "BLOCKED" && (p.status === "failed" || (p.httpStatus ?? 0) >= 500)).length;
  const outcome = computeOutcome({ crawlBlocked, siteAvailable, pagesBlocked, pagesNotEvaluated, pagesFailedOther, stoppedForBlock: Boolean(state.stoppedForBlock) });
  const blockedUrls = pages
    .filter((p) => p.errorCode === "BLOCKED")
    .slice(0, 20)
    .map((p) => ({ url: p.finalUrl ?? p.url, status: p.httpStatus, reason: p.errorMessage ?? "Access restricted" }));
  // Issues on pages we could not re-check are unknown, not "resolved".
  const notEvaluatedKeys = new Set(pages.filter((p) => p.errorCode === "BLOCKED" || p.errorCode === "NOT_EVALUATED").map((p) => urlKey(p.url)));

  const comparable = Boolean(baseline) && siteAvailable && !crawlBlocked;
  const diff = diffFingerprints(comparable ? baseline!.issueFingerprints : null, fingerprints);
  const prevIssueRows = baseline
    ? await db
        .select({ fingerprint: seoIssues.fingerprint, firstDetectedAt: seoIssues.firstDetectedAt, checkKey: seoIssues.checkKey, severity: seoIssues.severity, url: seoIssues.url, message: seoIssues.message })
        .from(seoIssues)
        .where(eq(seoIssues.scanId, baseline.id))
    : [];
  const firstSeen = new Map(prevIssueRows.map((r) => [r.fingerprint, r.firstDetectedAt]));
  const addedSet = new Set(diff.added.map((f) => f.slice(1)));
  const resolvedSet = new Set(diff.resolved.map((f) => f.slice(1)));
  const resolvedRows = prevIssueRows.filter((r) => resolvedSet.has(r.fingerprint) && !notEvaluatedKeys.has(urlKey(r.url)));

  const change: ScanChangeSummary = {
    previousScanId: baseline?.id ?? null,
    previousScore: baseline?.score ?? null,
    scoreDelta: comparable && score !== null && baseline?.score !== null && baseline?.score !== undefined ? score - baseline.score : null,
    newIssues: comparable
      ? evaluation.issues
          .filter((i) => addedSet.has(i.fingerprint))
          .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
          .slice(0, 50)
          .map((i) => ({ fingerprint: i.fingerprint, checkKey: i.checkKey, severity: i.severity, url: i.url, message: i.message }))
      : [],
    resolvedIssues: comparable
      ? resolvedRows
          .slice()
          .sort((a, b) => sevRank(a.severity) - sevRank(b.severity))
          .slice(0, 50)
          .map((r) => ({ fingerprint: r.fingerprint, checkKey: r.checkKey, severity: r.severity, url: r.url, message: r.message }))
      : [],
    newCriticalCount: comparable ? diff.addedBySeverity.c : 0,
    newWarningCount: comparable ? diff.addedBySeverity.w : 0,
    resolvedCount: comparable ? (prevIssueRows.length ? resolvedRows.length : diff.resolved.length) : 0,
    availabilityChanged: previousAny ? previousAny.siteAvailable !== siteAvailable : false,
    siteAvailable,
  };

  const okPages = pages.filter((p) => isOkHtmlPage(p as EvalPage));
  const responseTimes = okPages.map((p) => p.responseTimeMs).filter((n): n is number => n !== null);
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const i of evaluation.issues) counts[i.severity]++;
  const finalSiteChecks: SiteChecksSummary = {
    ...(siteChecks ?? {
      robotsTxt: { found: false, url: "", blocksAll: false, blocksGooglebot: false, blocksMonitor: false, sitemaps: [] },
      sitemap: { found: false, url: null, urlCount: 0 },
      homepageStatus: null,
      homepageHttps: false,
      importantPages: [],
      brokenInternalLinks: 0,
      brokenExternalLinks: 0,
      linksChecked: 0,
      duplicateTitles: 0,
      duplicateDescriptions: 0,
      avgResponseMs: null,
    }),
    importantPages,
    brokenInternalLinks: brokenLinks.filter((l) => l.isInternal).length,
    brokenExternalLinks: brokenLinks.filter((l) => !l.isInternal).length,
    linksChecked: linkStats?.checked ?? 0,
    duplicateTitles: evaluation.issues.filter((i) => i.checkKey === "title_duplicate").length,
    duplicateDescriptions: evaluation.issues.filter((i) => i.checkKey === "description_duplicate").length,
    avgResponseMs: responseTimes.length ? Math.round(responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) : null,
    pagesFailed: pages.filter((p) => p.errorCode !== "BLOCKED" && (p.status === "failed" || (p.httpStatus ?? 0) >= 400)).length,
    robotsBlockedCount: state.robotsBlockedCount,
    crawlBlocked,
    blockedReason: state.blockedReason ?? null,
    blockVendor: state.blockVendor ?? null,
    dataSource: remote ? "google_pagespeed" : crawlBlocked ? "none" : "direct",
    blockedUrls,
    pagesNotEvaluated,
    crawledFrom: { region: crawler.region, crawlerId: crawler.id },
    auditMode: remote ? "remote" : crawlBlocked ? "none" : "full",
    remoteAudit: state.remoteAudit ?? null,
    pagespeed,
  };

  const now = new Date();
  await db.transaction(async (tx) => {
    // Claim the scan first: if it was cancelled meanwhile, nothing below is written.
    const claimed = await tx
      .update(seoScans)
      .set({ updatedAt: now })
      .where(and(eq(seoScans.id, scan.id), inArray(seoScans.status, [...ACTIVE_STATUSES])))
      .returning({ id: seoScans.id });
    if (!claimed.length) throw new ScanCancelledError(scan.id);
    await tx.delete(seoChecks).where(eq(seoChecks.scanId, scan.id));
    await tx.delete(seoIssues).where(eq(seoIssues.scanId, scan.id));
    await tx.insert(seoChecks).values(
      scored.checks.map((c) => ({
        scanId: scan.id,
        checkKey: c.checkKey,
        category: c.category,
        label: c.label,
        status: c.status,
        passCount: Math.max(0, c.applicable - c.affected),
        warnCount: c.status === "warn" ? c.affected : 0,
        failCount: c.status === "fail" ? c.affected : 0,
        pointsDeducted: Math.round(c.pointsDeducted),
        maxPoints: c.maxPoints,
      })),
    );
    const issueRows = evaluation.issues.map((i) => ({
      scanId: scan.id,
      dealershipId: dealer.id,
      pageId: i.pageId,
      url: i.url.slice(0, 2000),
      checkKey: i.checkKey,
      category: i.category,
      severity: i.severity,
      message: i.message,
      recommendation: i.recommendation,
      details: i.details,
      fingerprint: i.fingerprint,
      firstDetectedAt: firstSeen.get(i.fingerprint) ?? now,
      isNew: comparable && addedSet.has(i.fingerprint),
    }));
    for (let k = 0; k < issueRows.length; k += 500) await tx.insert(seoIssues).values(issueRows.slice(k, k + 500));
    await tx.execute(sql`
      update ${scanPages} p set issue_count = s.n
      from (select page_id, count(*)::int as n from ${seoIssues} where scan_id = ${scan.id} and page_id is not null group by page_id) s
      where p.id = s.page_id and p.scan_id = ${scan.id}
    `);
    // Non-broken links are only needed during evaluation; drop them to keep storage lean.
    await tx.delete(scanLinks).where(and(eq(scanLinks.scanId, scan.id), eq(scanLinks.isBroken, false)));
    await tx
      .update(seoScans)
      .set({
        status: "completed",
        outcome,
        pagesBlocked,
        pagesNotEvaluated,
        crawlerId: crawler.id.slice(0, 120),
        completedAt: now,
        updatedAt: now,
        score,
        categoryScores: Object.fromEntries(Object.entries(scored.categories).filter(([, v]) => v.applicable).map(([k, v]) => [k, { score: v.score, max: v.max }])),
        criticalCount: counts.critical,
        warningCount: counts.warning,
        infoCount: counts.info,
        passedCount: scored.passed,
        pagesScanned: pages.filter((p) => p.status === "fetched").length,
        pagesFailed: finalSiteChecks.pagesFailed ?? 0,
        siteAvailable,
        siteChecks: finalSiteChecks,
        changeSummary: change,
        previousScanId: baseline?.id ?? null,
        issueFingerprints: fingerprints,
        crawlState: { ...state, phase: "finalize", robotsContent: null, linkQueue: [] },
        errorMessage: blockedMessage(state),
      })
      .where(eq(seoScans.id, scan.id));
    // One classification per requested URL, so dashboards, reports and the API count protected pages the same way.
    const byClass = new Map<string, number[]>();
    for (const p of pages) {
      const cls = classifyPageResult(p);
      if (!cls) continue;
      byClass.set(cls, [...(byClass.get(cls) ?? []), p.id]);
    }
    for (const [cls, ids] of byClass) {
      for (let k = 0; k < ids.length; k += 500) {
        await tx.update(scanPages).set({ resultClass: cls as NonNullable<ReturnType<typeof classifyPageResult>> }).where(inArray(scanPages.id, ids.slice(k, k + 500)));
      }
    }
    const analyzedAny = pages.some((p) => isAnalyzed(classifyPageResult(p)));
    await tx
      .update(dealerships)
      .set({ lastSeoScanId: scan.id, ...(analyzedAny ? { lastSuccessfulScanAt: now } : {}) })
      .where(eq(dealerships.id, dealer.id));
  });
  {
    const classes = pages.map((p) => classifyPageResult(p));
    const analyzed = classes.filter(isAnalyzed).length;
    const protectedCount = classes.filter(isProtected).length;
    const other = classes.filter((c) => c !== null && !isAnalyzed(c) && !isProtected(c) && c !== "SKIPPED").length;
    crawlerLog(`Completed: ${dealer.name} — ${analyzed} analyzed / ${protectedCount} protected / ${other} other (score ${score ?? "n/a"}, outcome ${outcome})`);
  }

  await logScanEvent(scan.id, "info", "Scan completed", {
    score,
    pages: pages.length,
    critical: counts.critical,
    warnings: counts.warning,
    newIssues: diff.added.length,
    resolved: change.resolvedCount,
  });

  try {
    await createScanAlerts({
      dealership: dealer,
      scanId: scan.id,
      score,
      siteAvailable,
      previousSiteAvailable: previousAny?.siteAvailable ?? null,
      hasBaseline: comparable,
      change,
      settings,
    });
    // Tell people once when access becomes restricted (not on every scan).
    if (outcome === "partially_blocked" && previousAny?.outcome !== "partially_blocked") {
      await createAlert(
        {
          dealershipId: dealer.id,
          scanId: scan.id,
          type: "scan_failed",
          severity: "warning",
          title: `${dealer.name}: scan partially blocked by website security`,
          message: `${pagesBlocked + pagesNotEvaluated} page(s) could not be evaluated because the website restricted automated access. These are not SEO problems.`,
          dedupeKey: `partial:${dealer.id}:${scan.id}`,
        },
        { settings, dealership: dealer },
      );
    }
    if (state.blockedReason === "firewall" && previousAny?.siteChecks?.blockedReason !== "firewall") {
      await createAlert(
        {
          dealershipId: dealer.id,
          scanId: scan.id,
          type: "scan_failed",
          severity: "warning",
          title: `${dealer.name}: scan blocked — requires review`,
          message: blockedMessage(state) ?? "",
          dedupeKey: `blocked:${dealer.id}:${scan.id}`,
        },
        { settings, dealership: dealer },
      );
    }
  } catch (err) {
    await logger.error("scan", "Failed to create alerts for scan", { scanId: scan.id, err }, dealer.id);
  }
}

function sevRank(s: string) {
  return s === "critical" ? 0 : s === "warning" ? 1 : 2;
}
