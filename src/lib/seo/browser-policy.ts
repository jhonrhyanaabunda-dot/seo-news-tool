/**
 * Pure helpers for the browser fetcher: request filtering, context eviction and
 * a concurrency gate. Kept free of Playwright and of `env()` so the rules that
 * protect the worker (and the SSRF filter in particular) can be unit tested
 * without launching a browser or touching a database.
 */

/** Subresource types that are never needed to evaluate HTML. */
const SKIPPED_RESOURCES = new Set(["image", "font", "media"]);

/**
 * Analytics, advertising and conversion-tracking endpoints. They add nothing a
 * search engine reads, but dealer pages load dozens of them and the browser's
 * "load" event waits for all. Tag managers are deliberately NOT listed: sites
 * sometimes inject structured data through them, and blocking that would report
 * schema as missing when it is not.
 */
const BEACON_HOSTS =
  /(^|\.)(google-analytics\.com|analytics\.google\.com|doubleclick\.net|googleadservices\.com|googlesyndication\.com|facebook\.net|bat\.bing\.com|clarity\.ms|hotjar\.com|hotjar\.io|analytics\.tiktok\.com|sc-static\.net|tr\.snapchat\.com|ct\.pinterest\.com|criteo\.com|criteo\.net|adroll\.com|taboola\.com|outbrain\.com|arttrk\.com|xad\.com|crwdcntrl\.net|adsrvr\.org|quantserve\.com|scorecardresearch\.com|demdex\.net|everesttech\.net|adnxs\.com)$/i;

export function isBeaconUrl(url: string): boolean {
  try {
    return BEACON_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export type RequestVerdict =
  /** Not http(s) — never allowed out of the browser. */
  | "block-scheme"
  /** A subresource we don't need; aborted to save the site's bandwidth and ours. */
  | "skip-resource"
  /** Main-frame navigation: needs full SSRF validation including DNS. */
  | "check-navigation"
  /** Other subresource: needs the cheap structural URL check. */
  | "check-subresource";

/**
 * What to do with one request the browser is about to make. Navigations get the
 * expensive check because a redirect is what could reach an internal address;
 * subresources get the structural one so each image doesn't cost a DNS lookup.
 */
export function classifyBrowserRequest(url: string, resourceType: string, isMainNavigation: boolean): RequestVerdict {
  if (!/^https?:/i.test(url)) return "block-scheme";
  if (SKIPPED_RESOURCES.has(resourceType)) return "skip-resource";
  if (!isMainNavigation && isBeaconUrl(url)) return "skip-resource";
  return isMainNavigation ? "check-navigation" : "check-subresource";
}

/** The slice of a Playwright page the challenge wait needs, so it can be tested without a browser. */
export interface SettlePage {
  content(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
  waitForLoadState(state: "domcontentloaded", options: { timeout: number }): Promise<void>;
}

/**
 * Give a JavaScript challenge a bounded chance to complete and return the
 * document the page settles on (which may still be the challenge, if it never
 * passes). Nothing is solved or forged: this only waits for the site's own
 * script to finish.
 *
 * A challenge that passes replaces the document, and reading the page while
 * that happens throws. That moment is the success case, so the wait continues
 * on the new document instead of stopping — stopping there kept the challenge
 * page and reported pages the site was about to serve as blocked.
 */
export async function settleChallenge(page: SettlePage, isBlocked: (html: string) => boolean, budgetMs: number, pollMs = 1500): Promise<string> {
  const deadline = Date.now() + budgetMs;
  let html = "";
  for (;;) {
    try {
      html = await page.content();
    } catch {
      if (Date.now() >= deadline) return html;
      try {
        await page.waitForLoadState("domcontentloaded", { timeout: Math.max(1, deadline - Date.now()) });
        // Guards against a tight loop if reading keeps failing on a document that has already loaded.
        await page.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now())));
      } catch {
        return html; // the page closed or never finished loading within the budget
      }
      continue;
    }
    if (!isBlocked(html) || Date.now() >= deadline) return html;
    await page.waitForTimeout(Math.min(pollMs, Math.max(0, deadline - Date.now())));
  }
}

/** The slice of a Playwright page the stability wait needs. */
export interface StablePage {
  evaluate<T>(expression: string): Promise<T>;
  waitForTimeout(ms: number): Promise<void>;
}

/**
 * Size of the rendered document: element count and visible text length.
 * A string expression rather than a function, so nothing is transpiled before it runs in the page.
 */
export const DOM_SIGNATURE_EXPRESSION = `document.getElementsByTagName("*").length + ":" + (document.body ? document.body.innerText.length : 0)`;

/**
 * Wait until the rendered page stops changing — the same element count and
 * text length on `stableSamples` consecutive reads — or the budget runs out.
 *
 * Dealer sites build much of their content with JavaScript after the document
 * arrives. Reading at that moment captured headings and text that weren't there
 * yet (and once, a 2 KB shell of a 460 KB homepage), so the same page scored
 * differently scan to scan. Returns whether the page settled; either way the
 * caller reads it, so a page that never goes quiet (a ticker, a live chat)
 * costs at most the budget.
 */
export async function waitForStableDom(page: StablePage, budgetMs: number, intervalMs = 500, stableSamples = 3): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let last: string | null = null;
  let same = 0;
  for (;;) {
    let signature: string | null = null;
    try {
      signature = await page.evaluate<string>(DOM_SIGNATURE_EXPRESSION);
    } catch {
      signature = null; // the document is being replaced; not stable yet
    }
    same = signature !== null && signature === last ? same + 1 : 1;
    last = signature;
    if (signature !== null && same >= stableSamples) return true;
    if (Date.now() + intervalMs > deadline) return false;
    try {
      await page.waitForTimeout(intervalMs);
    } catch {
      return false; // page closed
    }
  }
}

export interface EvictableContext {
  host: string;
  lastUsed: number;
  /** Number of fetches currently using this context. Never evict while in use. */
  inUse: number;
}

/**
 * Which per-host contexts to close, oldest first, so a long-running worker that
 * crawls many dealerships does not keep one Chromium context per host alive.
 * Contexts still serving a fetch are never chosen.
 */
export function selectEvictions<T extends EvictableContext>(entries: T[], max: number): T[] {
  const idle = entries.filter((e) => e.inUse === 0);
  const overBy = entries.length - max;
  if (overBy <= 0) return [];
  return [...idle].sort((a, b) => a.lastUsed - b.lastUsed).slice(0, Math.min(overBy, idle.length));
}

/**
 * Counting semaphore. Chromium costs far more memory than an HTTP request, so
 * the number of pages open at once is capped independently of JOB_CONCURRENCY —
 * otherwise four parallel scans each drive a browser and the worker runs out of
 * memory before it runs out of work.
 */
export class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.queue.shift()?.();
  }

  /** Run `fn` while holding a slot, releasing it even if `fn` throws. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get inFlight(): number {
    return this.active;
  }

  get waiting(): number {
    return this.queue.length;
  }
}
