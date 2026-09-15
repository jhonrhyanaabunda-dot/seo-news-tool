import "server-only";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { assertSafeUrl, assertUrlShape, UnsafeUrlError } from "@/lib/security/ssrf";
import { detectBlock } from "./block-detect";
import { classifyBrowserRequest, selectEvictions, Semaphore, settleChallenge, waitForStableDom } from "./browser-policy";
import type { FetchErrorCode, FetchOptions, FetchResult } from "./fetcher";
import { isSameSite } from "./url";

/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  Real-browser page fetch (Chromium via Playwright)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Some websites serve a JavaScript challenge instead of HTML to plain HTTP
 *  clients. A real browser runs that JavaScript and receives the page the site
 *  intends to serve.
 *
 *  This is NOT a bypass of a website's security controls:
 *
 *   • The crawler keeps identifying itself honestly as `A3SEOMonitor`
 *     (`CRAWLER_USER_AGENT`) — it never claims to be a human's browser.
 *   • robots.txt is still honoured; this module is only reached for URLs the
 *     crawl was already allowed to request.
 *   • No stealth/evasion patching (navigator.webdriver, fingerprint spoofing).
 *   • If the site still refuses, the refusal is recorded and the page is
 *     reported as "not evaluated", exactly as before.
 *
 *  Chromium cannot run on Vercel functions, so this only executes where a
 *  browser is available (the standalone worker, or local development).
 *  `safeFetch` stays the default path; this runs only as an escalation.
 */

type PWBrowser = import("playwright-core").Browser;
type PWBrowserContext = import("playwright-core").BrowserContext;
type PWPage = import("playwright-core").Page;
type PWRoute = import("playwright-core").Route;
type PWRequest = import("playwright-core").Request;
type PWResponse = import("playwright-core").Response;

let browserPromise: Promise<PWBrowser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let gate: Semaphore | null = null;

/** Caps how many browser pages are open at once (see BROWSER_MAX_CONCURRENCY). */
function concurrencyGate(): Semaphore {
  if (!gate) gate = new Semaphore(env().BROWSER_MAX_CONCURRENCY);
  return gate;
}

interface CtxEntry {
  ctx: PWBrowserContext;
  lastUsed: number;
  /** Fetches currently using this context; it is never evicted while above zero. */
  inUse: number;
}

/**
 * One browser context (cookie jar) per host, reused for every page of that
 * site's crawl.
 *
 * This matters for correctness as much as for speed: when a site issues a
 * clearance cookie after its challenge is satisfied, a browser is expected to
 * send it back on subsequent requests. Throwing the cookie away and arriving as
 * a brand-new visitor on every page makes the site re-challenge each request —
 * which both wastes its resources and looks far more like abuse than a normal
 * visit. Keeping the session the site handed us is the polite behaviour.
 */
const contexts = new Map<string, CtxEntry>();

/** In-flight context creations, so two concurrent fetches for one host share a context. */
const creating = new Map<string, Promise<CtxEntry>>();

/** Per-page record so the shared route handler can report an unsafe redirect back to its own fetch. */
const pageState = new WeakMap<PWPage, { unsafeRedirect: string | null }>();

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

function launchOptions() {
  const e = env();
  const args = ["--disable-dev-shm-usage", "--disable-gpu"];
  // Container images typically run as root, where Chromium's sandbox cannot start.
  if (e.BROWSER_NO_SANDBOX) args.push("--no-sandbox", "--disable-setuid-sandbox");
  return {
    headless: true,
    args,
    ...(e.BROWSER_EXECUTABLE_PATH ? { executablePath: e.BROWSER_EXECUTABLE_PATH } : {}),
    ...(e.BROWSER_CHANNEL ? { channel: e.BROWSER_CHANNEL } : {}),
  };
}

async function getBrowser(): Promise<PWBrowser> {
  if (!browserPromise) {
    browserPromise = (async () => {
      let chromium;
      try {
        ({ chromium } = await import("playwright-core"));
      } catch {
        throw new BrowserUnavailableError("playwright-core is not installed in this environment.");
      }
      try {
        return await chromium.launch(launchOptions());
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new BrowserUnavailableError(
          `Chromium could not be started (${msg.split("\n")[0]}). Install it with "npx playwright install chromium", or set BROWSER_EXECUTABLE_PATH / BROWSER_CHANNEL.`,
        );
      }
    })();
    browserPromise.catch(() => {
      browserPromise = null;
    });
  }
  return browserPromise;
}

/**
 * A context per host, created on first use and kept for the rest of that
 * site's crawl so cookies the site issued are sent back as any browser would.
 */
async function createContext(host: string, timeoutMs: number): Promise<CtxEntry> {
  const e = env();
  const browser = await getBrowser();
  const ctx = await browser.newContext({
    userAgent: e.CRAWLER_USER_AGENT,
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    serviceWorkers: "block",
  });
  ctx.setDefaultTimeout(timeoutMs);

  // Registered once per context; it applies to every page opened from it.
  await ctx.route("**/*", async (route: PWRoute, request: PWRequest) => {
    const frame = request.frame();
    const isMainNavigation = request.isNavigationRequest() && frame.parentFrame() === null;
    const verdict = classifyBrowserRequest(request.url(), request.resourceType(), isMainNavigation);
    if (verdict === "block-scheme" || verdict === "skip-resource") return route.abort("blockedbyclient");
    try {
      // Navigations get the full check (including DNS) because a redirect is
      // what could reach an internal address; subresources get the cheap
      // structural one so each asset doesn't cost a DNS round-trip.
      if (verdict === "check-navigation") await assertSafeUrl(request.url());
      else assertUrlShape(request.url());
    } catch (err) {
      if (isMainNavigation) {
        const st = pageState.get(frame.page());
        if (st) st.unsafeRedirect = err instanceof UnsafeUrlError ? err.message : "Unsafe redirect target";
      }
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });

  const entry: CtxEntry = { ctx, lastUsed: Date.now(), inUse: 0 };
  contexts.set(host, entry);
  return entry;
}

/**
 * Borrow the context for a host, creating it on first use. The caller must
 * `release()` so the context becomes evictable again.
 */
async function acquireContext(host: string, timeoutMs: number): Promise<{ ctx: PWBrowserContext; release: () => void }> {
  let entry = contexts.get(host);
  if (!entry) {
    // Two fetches for the same host must not each build a context.
    let pending = creating.get(host);
    if (!pending) {
      pending = createContext(host, timeoutMs).finally(() => creating.delete(host));
      creating.set(host, pending);
    }
    entry = await pending;
  }
  entry.lastUsed = Date.now();
  entry.inUse++;
  const held = entry;
  await evictIdleContexts();
  return {
    ctx: held.ctx,
    release: () => {
      held.inUse = Math.max(0, held.inUse - 1);
      held.lastUsed = Date.now();
    },
  };
}

/** Close least-recently-used idle contexts once past BROWSER_MAX_CONTEXTS. */
async function evictIdleContexts(): Promise<void> {
  const entries = [...contexts.entries()].map(([host, e]) => ({ host, lastUsed: e.lastUsed, inUse: e.inUse }));
  for (const victim of selectEvictions(entries, env().BROWSER_MAX_CONTEXTS)) {
    const entry = contexts.get(victim.host);
    if (!entry || entry.inUse > 0) continue;
    contexts.delete(victim.host);
    await entry.ctx.close().catch(() => {});
  }
}

/** Close the shared browser and every per-host context (on idle and on worker shutdown). */
export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  for (const [host, entry] of contexts) {
    contexts.delete(host);
    await entry.ctx.close().catch(() => {});
  }
  creating.clear();
  // The gate deliberately outlives the browser: a fetch still holding a slot
  // must release it against the same semaphore it acquired from.
  const p = browserPromise;
  browserPromise = null;
  if (!p) return;
  try {
    const b = await p;
    await b.close();
  } catch {
    /* already gone */
  }
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer);
  const ms = env().BROWSER_IDLE_TIMEOUT_MS;
  if (ms <= 0) return;
  idleTimer = setTimeout(() => {
    void closeBrowser();
  }, ms);
  idleTimer.unref?.();
}

function classifyBrowserError(err: unknown): { code: FetchErrorCode; message: string } {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Timeout .* exceeded|TimeoutError/i.test(msg)) return { code: "TIMEOUT", message: "Request timed out" };
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/i.test(msg)) return { code: "DNS", message: "DNS lookup failed" };
  if (/ERR_CERT|ERR_SSL|ERR_BAD_SSL/i.test(msg)) return { code: "TLS", message: "TLS certificate error" };
  if (/ERR_CONNECTION|ERR_ADDRESS_UNREACHABLE|ERR_NETWORK|ERR_EMPTY_RESPONSE|ERR_ABORTED/i.test(msg))
    return { code: "CONNECTION", message: "Connection failed" };
  return { code: "UNKNOWN", message: msg.split("\n")[0] };
}

/**
 * Fetch one page with Chromium and return the same shape as `safeFetch`, so
 * callers and the scan engine are unchanged.
 *
 * SSRF protection is re-applied here: Playwright follows redirects and loads
 * subresources internally, so every request is validated in a route handler
 * rather than relying on the fetcher's per-hop checks.
 */
export async function browserFetch(inputUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const e = env();
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? e.BROWSER_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? 3 * 1024 * 1024;
  const chain: string[] = [];

  const base: FetchResult = {
    ok: false,
    status: null,
    finalUrl: inputUrl,
    redirected: false,
    redirectChain: chain,
    headers: {},
    contentType: null,
    body: null,
    bytes: 0,
    truncated: false,
    ttfbMs: 0,
    totalMs: 0,
    errorCode: null,
    errorMessage: null,
    fetchMethod: "browser",
  };
  const finish = (partial: Partial<FetchResult>): FetchResult => ({
    ...base,
    ...partial,
    totalMs: Math.round(performance.now() - started),
  });

  let origin: URL;
  try {
    origin = (await assertSafeUrl(inputUrl)).url;
  } catch (err) {
    return finish({ errorCode: "UNSAFE_URL", errorMessage: err instanceof Error ? err.message : "Unsafe URL" });
  }

  // Cap open pages before taking a context, so queued fetches don't each hold
  // a browser context open while waiting for a slot.
  await concurrencyGate().acquire();
  // One cookie jar per host, kept across the crawl (see `contexts`).
  // If the browser cannot start, the slot must be handed back or the gate leaks.
  let held: { ctx: PWBrowserContext; release: () => void };
  try {
    held = await acquireContext(origin.host, timeoutMs);
  } catch (err) {
    concurrencyGate().release();
    throw err;
  }
  const { ctx: context, release: releaseContext } = held;

  // Track the most recent main-frame document response: when a challenge
  // resolves it reloads the page, and that final response is the real one.
  let mainStatus: number | null = null;
  let mainHeaders: Record<string, string> = {};
  let mainContentType: string | null = null;
  // Held in an object: assigned only inside the response listener, which the
  // compiler cannot see as a narrowing assignment on a plain local.
  const mainRef: { res: PWResponse | null } = { res: null };
  let ttfbMs = 0;
  let page: PWPage | null = null;
  const st: { unsafeRedirect: string | null } = { unsafeRedirect: null };

  try {
    const pg = await context.newPage();
    page = pg;
    pageState.set(pg, st);

    pg.on("response", (res: PWResponse) => {
      const req = res.request();
      if (req.frame() !== pg.mainFrame() || req.resourceType() !== "document") return;
      if (ttfbMs === 0) ttfbMs = Math.round(performance.now() - started);
      const status = res.status();
      if (status >= 300 && status < 400) {
        chain.push(res.url());
        return;
      }
      mainStatus = status;
      mainRef.res = res;
      mainHeaders = {};
      for (const [k, v] of Object.entries(res.headers())) mainHeaders[k.toLowerCase()] = v;
      mainContentType = mainHeaders["content-type"] ?? null;
    });

    try {
      await pg.goto(inputUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (err) {
      if (st.unsafeRedirect) return finish({ errorCode: "UNSAFE_URL", errorMessage: st.unsafeRedirect, ttfbMs });
      // A navigation the page itself supersedes — a script or meta redirect,
      // such as adding a trailing slash — aborts the original goto even though
      // the browser did land on a real document. Treat it as a failure only
      // when no document response actually arrived.
      const aborted = /ERR_ABORTED/i.test(err instanceof Error ? err.message : String(err));
      if (aborted) await pg.waitForTimeout(1500).catch(() => {});
      if (!aborted || mainStatus === null) {
        const { code, message } = classifyBrowserError(err);
        return finish({ errorCode: code, errorMessage: message, status: mainStatus, ttfbMs });
      }
    }
    if (st.unsafeRedirect) return finish({ errorCode: "UNSAFE_URL", errorMessage: st.unsafeRedirect, ttfbMs });

    // Give a JavaScript challenge a bounded chance to complete. The page
    // reloads itself when it passes, and the response listener picks up the
    // new document's status. We never solve or forge anything.
    const stillBlocked = (body: string) => detectBlock({ status: mainStatus, headers: mainHeaders, body }).blocked;
    let html = await settleChallenge(pg, stillBlocked, e.BROWSER_CHALLENGE_WAIT_MS);

    // Let JavaScript finish building the page before reading it, so the same page scores the same every scan.
    if (!stillBlocked(html) && e.BROWSER_SETTLE_MS > 0) {
      const settleUntil = Date.now() + e.BROWSER_SETTLE_MS;
      // "load" waits for every third-party asset; give it a short cap and let the DOM-stability check decide when content is done.
      await pg.waitForLoadState("load", { timeout: Math.min(3000, e.BROWSER_SETTLE_MS) }).catch(() => {});
      await waitForStableDom(pg, Math.max(0, settleUntil - Date.now()));
      // Re-read the settled document; a short challenge budget covers a read that lands mid-navigation.
      html = await settleChallenge(pg, stillBlocked, 3000);
    }

    const finalUrl = pg.url();
    let offsite = false;
    try {
      offsite = !isSameSite(origin, new URL(finalUrl));
    } catch {
      offsite = true;
    }
    if (options.sameSiteOnly && offsite) {
      return finish({
        status: mainStatus,
        headers: mainHeaders,
        contentType: mainContentType,
        ttfbMs,
        finalUrl,
        redirected: true,
        errorCode: "REDIRECT_OFFSITE",
        errorMessage: `Redirects to ${(() => {
          try {
            return new URL(finalUrl).hostname;
          } catch {
            return "another site";
          }
        })()}`,
      });
    }

    const isHtml = !mainContentType || /text\/html|application\/xhtml\+xml/i.test(mainContentType);
    if (options.htmlOnly && !isHtml) {
      return finish({
        status: mainStatus,
        headers: mainHeaders,
        contentType: mainContentType,
        ttfbMs,
        finalUrl,
        redirected: chain.length > 0,
        errorCode: "NOT_HTML",
        errorMessage: `Content type ${mainContentType}`,
      });
    }

    const fullBytes = Buffer.byteLength(html, "utf8");
    const truncated = fullBytes > maxBytes;
    if (truncated) html = html.slice(0, maxBytes);

    // Real server timing for the document. `totalMs` here covers browser
    // startup, JavaScript and any challenge wait, so it must not be reported as
    // the site's response time — that would flag every rendered page as slow.
    let serverResponseMs: number | null = null;
    if (mainRef.res) {
      try {
        const t = await mainRef.res.request().timing();
        if (t && t.requestStart >= 0 && t.responseStart >= t.requestStart) {
          ttfbMs = Math.round(t.responseStart - t.requestStart);
          serverResponseMs = Math.round((t.responseEnd > t.requestStart ? t.responseEnd : t.responseStart) - t.requestStart);
        }
      } catch {
        /* timing unavailable (served from cache) — fall back to totalMs */
      }
    }

    return finish({
      ok: mainStatus !== null && mainStatus >= 200 && mainStatus < 300,
      serverResponseMs,
      status: mainStatus,
      headers: mainHeaders,
      contentType: mainContentType,
      body: html,
      bytes: Math.min(fullBytes, maxBytes),
      truncated,
      ttfbMs,
      finalUrl,
      redirected: chain.length > 0 || finalUrl !== inputUrl,
    });
  } catch (err) {
    const { code, message } = classifyBrowserError(err);
    return finish({ errorCode: code, errorMessage: message, ttfbMs });
  } finally {
    // Close only the page — the context (and the cookies this site issued)
    // stays alive for the rest of this host's crawl.
    await page?.close().catch(() => {});
    releaseContext();
    concurrencyGate().release();
    scheduleIdleClose();
  }
}

export interface RawFetchOptions extends FetchOptions {
  /**
   * Open the resource itself instead of the homepage before requesting it. Used
   * for robots.txt, whose rules must be known before any page is loaded.
   */
  landOnTarget?: boolean;
}

/**
 * Fetch a non-HTML resource (an XML sitemap) through the browser's own network
 * stack and cookie jar, without rendering it.
 *
 * Chromium turns XML into a viewer document, so `page.content()` returns the
 * viewer's markup rather than the sitemap. The context's request API returns
 * the bytes as served while still sending the cookies this site issued, which
 * is what gets past a challenge the plain client cannot satisfy.
 */
export async function browserFetchRaw(inputUrl: string, options: RawFetchOptions = {}): Promise<FetchResult> {
  const e = env();
  const started = performance.now();
  const timeoutMs = options.timeoutMs ?? e.BROWSER_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? 3 * 1024 * 1024;

  const base: FetchResult = {
    ok: false,
    status: null,
    finalUrl: inputUrl,
    redirected: false,
    redirectChain: [],
    headers: {},
    contentType: null,
    body: null,
    bytes: 0,
    truncated: false,
    ttfbMs: 0,
    totalMs: 0,
    errorCode: null,
    errorMessage: null,
    fetchMethod: "browser",
  };
  const finish = (partial: Partial<FetchResult>): FetchResult => ({ ...base, ...partial, totalMs: Math.round(performance.now() - started) });

  let origin: URL;
  try {
    origin = (await assertSafeUrl(inputUrl)).url;
  } catch (err) {
    return finish({ errorCode: "UNSAFE_URL", errorMessage: err instanceof Error ? err.message : "Unsafe URL" });
  }

  await concurrencyGate().acquire();
  let held: { ctx: PWBrowserContext; release: () => void };
  try {
    held = await acquireContext(origin.host, timeoutMs);
  } catch (err) {
    concurrencyGate().release();
    throw err;
  }
  const { ctx: context, release: releaseContext } = held;
  let page: PWPage | null = null;
  try {
    const pg = await context.newPage();
    page = pg;
    pageState.set(pg, { unsafeRedirect: null });

    // Land on the site first, then let the *page* issue the request. Playwright's
    // own request API is a separate client, and a site that challenges plain
    // clients refuses it even with the right cookies; a request made from the
    // page uses the browser's network stack, so the site sees the same visitor
    // it already served.
    const target = new URL(inputUrl);
    await pg.goto(options.landOnTarget ? inputUrl : `${target.origin}/`, { waitUntil: "domcontentloaded", timeout: timeoutMs }).catch(() => {});

    // Wait for any challenge on the landing page to finish first: a request
    // issued while the page is still being challenged inherits that refusal,
    // and the sitemap would be reported missing when it simply was not served.
    await settleChallenge(pg, (body) => detectBlock({ status: null, headers: {}, body }).blocked, e.BROWSER_CHALLENGE_WAIT_MS);

    const out = await pg.evaluate(
      async ({ url, accept }: { url: string; accept: string }) => {
        try {
          const r = await fetch(url, { credentials: "include", headers: { Accept: accept } });
          // Text, not bytes: a gzipped (.xml.gz) sitemap is not decoded here.
          // Those still work on the plain path, which handles gzip itself.
          const text = await r.text();
          const headers: Record<string, string> = {};
          r.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
          return { ok: r.ok, status: r.status, url: r.url, text, headers, error: null as string | null };
        } catch (e) {
          return { ok: false, status: 0, url, text: "", headers: {} as Record<string, string>, error: String((e as Error)?.message ?? e) };
        }
      },
      { url: inputUrl, accept: options.accept ?? "application/xml,text/xml,*/*;q=0.8" },
    );

    if (out.error) return finish({ errorCode: "CONNECTION", errorMessage: out.error, ttfbMs: Math.round(performance.now() - started) });
    const truncated = out.text.length > maxBytes;
    const body = truncated ? out.text.slice(0, maxBytes) : out.text;
    return finish({
      ok: out.ok,
      status: out.status || null,
      headers: out.headers,
      contentType: out.headers["content-type"] ?? null,
      body,
      bytes: Buffer.byteLength(body, "utf8"),
      truncated,
      ttfbMs: Math.round(performance.now() - started),
      finalUrl: out.url || inputUrl,
      redirected: Boolean(out.url) && out.url !== inputUrl,
    });
  } catch (err) {
    const { code, message } = classifyBrowserError(err);
    return finish({ errorCode: code, errorMessage: message });
  } finally {
    await page?.close().catch(() => {});
    releaseContext();
    concurrencyGate().release();
    scheduleIdleClose();
  }
}

export interface BrowserLinkCheck {
  url: string;
  status: number | null;
  /**
   * "UNVERIFIABLE" when the browser itself would not make the request (mixed
   * content, CORS, a client-side block): a limit of the checker, never evidence
   * that the link is broken.
   */
  errorCode: FetchErrorCode | "UNVERIFIABLE" | null;
  /** The site refused this request too (401/403/429). */
  refused: boolean;
}

/**
 * Check same-site link targets that the plain client was refused on, from a
 * page on that site — through the browser session that already satisfied the
 * site's challenge, as a visitor's browser would request them.
 *
 * Politeness and safety match the crawl: one page per call, requests issued one
 * at a time with a delay, header-only (HEAD, falling back to GET only when HEAD
 * is not supported), redirects not followed (a redirect is a working link, and
 * no request leaves the site), and checking stops after two refusals in a row.
 *
 * Returns the URLs actually checked, in order, and why checking stopped — or
 * null when no browser is available. Only "deadline" is worth resuming; any
 * other stop is final for this scan so a failure can never turn into a loop of
 * repeated visits to the site.
 */
export type LinkCheckStop = "done" | "deadline" | "refused" | "error" | "cancelled";

export async function browserCheckLinks(
  urls: string[],
  opts: { delayMs: number; deadline: number; timeoutMs?: number; /** Re-checked every few links so a cancelled scan stops promptly. */ isActive?: () => Promise<boolean> },
): Promise<{ checked: BrowserLinkCheck[]; stopped: LinkCheckStop } | null> {
  const e = env();
  if (urls.length === 0) return { checked: [], stopped: "done" };
  const perLinkMs = opts.timeoutMs ?? 10_000;
  // Don't load the site at all unless there is time to land and check at least one link.
  if (Date.now() + e.BROWSER_TIMEOUT_MS + perLinkMs + opts.delayMs > opts.deadline) return { checked: [], stopped: "deadline" };

  let origin: URL;
  try {
    origin = (await assertSafeUrl(urls[0])).url;
  } catch {
    return { checked: [], stopped: "error" };
  }

  await concurrencyGate().acquire();
  let held: { ctx: PWBrowserContext; release: () => void };
  try {
    held = await acquireContext(origin.host, e.BROWSER_TIMEOUT_MS);
  } catch (err) {
    concurrencyGate().release();
    if (err instanceof BrowserUnavailableError) {
      logger.warn("browser-fetch", err.message);
      return null;
    }
    throw err;
  }
  const { ctx: context, release: releaseContext } = held;
  const checked: BrowserLinkCheck[] = [];
  let page: PWPage | null = null;
  try {
    const pg = await context.newPage();
    page = pg;
    pageState.set(pg, { unsafeRedirect: null });
    let landingStatus: number | null = null;
    pg.on("response", (res: PWResponse) => {
      if (res.request().frame() === pg.mainFrame() && res.request().resourceType() === "document") landingStatus = res.status();
    });
    await pg.goto(`${origin.origin}/`, { waitUntil: "domcontentloaded", timeout: e.BROWSER_TIMEOUT_MS }).catch(() => {});
    const landing = await settleChallenge(pg, (body) => detectBlock({ status: landingStatus, headers: {}, body }).blocked, e.BROWSER_CHALLENGE_WAIT_MS);
    // The session was never admitted, so every request from it would be refused as well.
    if (detectBlock({ status: landingStatus, headers: {}, body: landing }).blocked) return { checked, stopped: "refused" };

    let refusedStreak = 0;
    // Two header-only requests at a time, with the politeness delay between pairs.
    const LINKS_AT_ONCE = 2;
    for (let index = 0; index < urls.length; index += LINKS_AT_ONCE) {
      if (Date.now() + perLinkMs + opts.delayMs > opts.deadline) return { checked, stopped: "deadline" };
      if (opts.isActive && index % 6 === 0 && !(await opts.isActive())) return { checked, stopped: "cancelled" };
      const pair: Array<{ url: string; target: string | null }> = [];
      for (const url of urls.slice(index, index + LINKS_AT_ONCE)) {
        try {
          const safe = (await assertSafeUrl(url)).url;
          if (!isSameSite(origin, safe)) {
            pair.push({ url, target: null });
            continue;
          }
          // The page may only request its own origin, so a link to the same site at another address is checked where
          // a visitor following it ends up: https:// rather than http:// (a secure page cannot request an insecure
          // URL), and the site's own www/non-www host rather than the other (a cross-origin request is refused).
          if (origin.protocol === "https:" && safe.protocol === "http:") safe.protocol = "https:";
          if (safe.hostname !== origin.hostname) safe.hostname = origin.hostname;
          pair.push({ url, target: safe.toString() });
        } catch {
          pair.push({ url, target: null });
        }
      }
      await pg.waitForTimeout(opts.delayMs);
      const results = await Promise.all(
        pair.map(({ target }) =>
          target === null
            ? Promise.resolve(null)
            : pg.evaluate(
                // Runs inside the page, so it must be self-contained: no named inner functions, because the
                // TypeScript runner wraps those in a helper (__name) that does not exist in the browser.
                async ({ url, timeoutMs }: { url: string; timeoutMs: number }) => {
                  const init: RequestInit = { credentials: "include", redirect: "manual", cache: "no-store" };
                  try {
                    let r = await fetch(url, { ...init, method: "HEAD", signal: AbortSignal.timeout(timeoutMs) });
                    if (r.status === 405 || r.status === 501) {
                      r = await fetch(url, { ...init, method: "GET", signal: AbortSignal.timeout(timeoutMs) });
                      void r.body?.cancel(); // only the status is needed
                    }
                    // An opaque redirect has no readable status; it means the link redirects rather than fails.
                    return { status: r.type === "opaqueredirect" ? null : r.status, error: null as string | null };
                  } catch (err) {
                    // fetch() rejects with a TypeError for anything the browser refuses to send, which says nothing about the site.
                    return { status: null, error: (err as Error)?.name === "TimeoutError" ? "TIMEOUT" : "UNVERIFIABLE" };
                  }
                },
                { url: target, timeoutMs: perLinkMs },
              ),
        ),
      );
      for (const [k, { url }] of pair.entries()) {
        const out = results[k];
        if (out === null) {
          checked.push({ url, status: null, errorCode: "UNSAFE_URL", refused: false });
          continue;
        }
        const refused = out.status === 401 || out.status === 403 || out.status === 429;
        checked.push({ url, status: out.status, errorCode: (out.error as BrowserLinkCheck["errorCode"]) ?? null, refused });
        refusedStreak = refused ? refusedStreak + 1 : 0;
      }
      if (refusedStreak >= 2) return { checked, stopped: "refused" };
    }
    return { checked, stopped: "done" };
  } catch (err) {
    logger.warn("browser-fetch", `Browser link checks stopped for ${origin.host}: ${err instanceof Error ? err.message : String(err)}`);
    return { checked, stopped: "error" };
  } finally {
    await page?.close().catch(() => {});
    releaseContext();
    concurrencyGate().release();
    scheduleIdleClose();
  }
}

/** `browserFetchRaw` that returns null instead of throwing when no browser is available. */
export async function browserRetryRaw(url: string, options: RawFetchOptions = {}): Promise<FetchResult | null> {
  try {
    return await browserFetchRaw(url, options);
  } catch (err) {
    if (err instanceof BrowserUnavailableError) {
      logger.warn("browser-fetch", err.message);
      return null;
    }
    logger.warn("browser-fetch", `Raw browser fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Escalate a blocked plain-HTTP response to the browser, once.
 * Returns null when rendering is unavailable, so the caller keeps the original
 * result and reports the refusal as before.
 */
export async function browserRetry(url: string, options: FetchOptions = {}): Promise<FetchResult | null> {
  try {
    return await browserFetch(url, options);
  } catch (err) {
    if (err instanceof BrowserUnavailableError) {
      logger.warn("browser-fetch", err.message);
      return null;
    }
    logger.warn("browser-fetch", `Browser fetch failed for ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
