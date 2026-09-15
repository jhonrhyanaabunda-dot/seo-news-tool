import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBrowserRequest, selectEvictions, Semaphore, settleChallenge, waitForStableDom, type SettlePage, type StablePage } from "@/lib/seo/browser-policy";

test("only http(s) requests leave the browser", () => {
  assert.equal(classifyBrowserRequest("file:///etc/passwd", "document", true), "block-scheme");
  assert.equal(classifyBrowserRequest("chrome://settings", "document", true), "block-scheme");
  assert.equal(classifyBrowserRequest("data:text/html,<h1>x", "document", false), "block-scheme");
  assert.equal(classifyBrowserRequest("https://example.com/", "document", true), "check-navigation");
});

test("heavy subresources are skipped, real ones are still validated", () => {
  assert.equal(classifyBrowserRequest("https://example.com/a.png", "image", false), "skip-resource");
  assert.equal(classifyBrowserRequest("https://example.com/a.woff2", "font", false), "skip-resource");
  assert.equal(classifyBrowserRequest("https://example.com/v.mp4", "media", false), "skip-resource");
  assert.equal(classifyBrowserRequest("https://example.com/a.js", "script", false), "check-subresource");
  assert.equal(classifyBrowserRequest("https://example.com/api", "fetch", false), "check-subresource");
});

test("navigations get the stricter check than subresources", () => {
  // A redirect is what could reach an internal address, so it must be DNS-checked.
  assert.equal(classifyBrowserRequest("https://internal.example/", "document", true), "check-navigation");
  assert.equal(classifyBrowserRequest("https://internal.example/x.css", "stylesheet", false), "check-subresource");
});

test("eviction closes the oldest idle contexts only", () => {
  const entries = [
    { host: "a.com", lastUsed: 100, inUse: 0 },
    { host: "b.com", lastUsed: 200, inUse: 0 },
    { host: "c.com", lastUsed: 300, inUse: 0 },
  ];
  assert.deepEqual(
    selectEvictions(entries, 2).map((e) => e.host),
    ["a.com"],
  );
  assert.deepEqual(selectEvictions(entries, 3), []);
  assert.deepEqual(selectEvictions(entries, 5), []);
});

test("a context still serving a fetch is never evicted", () => {
  const entries = [
    { host: "busy.com", lastUsed: 1, inUse: 1 },
    { host: "idle.com", lastUsed: 999, inUse: 0 },
  ];
  // busy.com is the oldest but in use, so idle.com is chosen instead.
  assert.deepEqual(
    selectEvictions(entries, 1).map((e) => e.host),
    ["idle.com"],
  );
  // Nothing idle to drop: return nothing rather than closing a context in use.
  assert.deepEqual(selectEvictions([{ host: "busy.com", lastUsed: 1, inUse: 2 }], 0), []);
});

test("the semaphore caps concurrency and hands slots to waiters in order", async () => {
  const gate = new Semaphore(2);
  const running: number[] = [];
  let peak = 0;
  let current = 0;

  const task = (id: number) =>
    gate.run(async () => {
      current++;
      peak = Math.max(peak, current);
      running.push(id);
      await new Promise((r) => setTimeout(r, 10));
      current--;
    });

  await Promise.all([task(1), task(2), task(3), task(4), task(5)]);
  assert.equal(peak, 2, "never more than the limit ran at once");
  assert.equal(running.length, 5, "every task ran");
  assert.equal(gate.inFlight, 0, "all slots returned");
  assert.equal(gate.waiting, 0);
});

test("a slot is returned even when the work throws", async () => {
  const gate = new Semaphore(1);
  await assert.rejects(gate.run(async () => {
    throw new Error("boom");
  }));
  assert.equal(gate.inFlight, 0);
  // The gate is still usable afterwards.
  await gate.run(async () => undefined);
  assert.equal(gate.inFlight, 0);
});

/** A page that serves a challenge, then reloads into the real document the way a passing Cloudflare challenge does. */
function challengePage(opts: { passAfterMs: number | null; reloadMs?: number }): SettlePage & { reads: number } {
  const start = Date.now();
  const reloadMs = opts.reloadMs ?? 300;
  const phase = () => {
    const t = Date.now() - start;
    if (opts.passAfterMs === null || t < opts.passAfterMs) return "challenge";
    return t < opts.passAfterMs + reloadMs ? "navigating" : "real";
  };
  const page = {
    reads: 0,
    async content() {
      page.reads++;
      const p = phase();
      if (p === "navigating") throw new Error("Execution context was destroyed, most likely because of a navigation");
      return p === "real" ? "<html><title>New Subaru Trailseeker</title></html>" : "<html><title>Just a moment...</title></html>";
    },
    async waitForTimeout(ms: number) {
      await new Promise((r) => setTimeout(r, ms));
    },
    async waitForLoadState(_s: "domcontentloaded", { timeout }: { timeout: number }) {
      const until = start + (opts.passAfterMs ?? Infinity) + reloadMs;
      const wait = until - Date.now();
      if (wait > timeout) throw new Error("Timeout exceeded");
      await new Promise((r) => setTimeout(r, Math.max(0, wait)));
    },
  };
  return page;
}
const isChallenge = (h: string) => h.includes("Just a moment");

test("a challenge that passes mid-read is followed to the real page, not reported as blocked", async () => {
  // The read lands inside the reload window, which is exactly when the old loop gave up.
  const page = challengePage({ passAfterMs: 40, reloadMs: 400 });
  const html = await settleChallenge(page, isChallenge, 5000, 50);
  assert.match(html, /New Subaru Trailseeker/);
});

test("a challenge that never passes is returned as-is once the budget runs out", async () => {
  const started = Date.now();
  const html = await settleChallenge(challengePage({ passAfterMs: null }), isChallenge, 300, 50);
  assert.ok(isChallenge(html));
  assert.ok(Date.now() - started < 1000, "the wait is bounded by its budget");
});

test("an unblocked page is returned immediately", async () => {
  const page = challengePage({ passAfterMs: 0, reloadMs: 0 });
  await new Promise((r) => setTimeout(r, 5));
  const html = await settleChallenge(page, isChallenge, 5000);
  assert.match(html, /Trailseeker/);
  assert.equal(page.reads, 1);
});

/** A page whose DOM signature follows a script: "nav" throws as if mid-navigation, strings are signatures. */
function scriptedPage(script: Array<string | "nav">): StablePage & { reads: number } {
  const page = {
    reads: 0,
    async evaluate<T>(): Promise<T> {
      const step = script[Math.min(page.reads++, script.length - 1)];
      if (step === "nav") throw new Error("Execution context was destroyed");
      return step as T;
    },
    async waitForTimeout(ms: number) {
      await new Promise((r) => setTimeout(r, ms));
    },
  };
  return page;
}

test("a page still being built is not read until it stops changing", async () => {
  // Real sequence seen on a dealer homepage: a 2 KB shell, the document swap, then content filling in.
  const page = scriptedPage(["12:40", "nav", "1480:900", "5210:2300", "5230:2323", "5230:2323", "5230:2323"]);
  assert.equal(await waitForStableDom(page, 5000, 10), true);
  assert.equal(page.reads, 7, "stops as soon as three reads agree");
});

test("a page that never settles costs at most the budget", async () => {
  let n = 0;
  const page: StablePage = { evaluate: async <T,>() => `${n++}:0` as T, waitForTimeout: (ms) => new Promise((r) => setTimeout(r, ms)) };
  const started = Date.now();
  assert.equal(await waitForStableDom(page, 200, 20), false);
  assert.ok(Date.now() - started < 600);
});

test("a page that is already complete settles after the minimum reads", async () => {
  const page = scriptedPage(["5230:2323"]);
  assert.equal(await waitForStableDom(page, 5000, 10), true);
  assert.equal(page.reads, 3);
});

test("ad and analytics beacons are skipped; content scripts and tag managers are not", () => {
  assert.equal(classifyBrowserRequest("https://www.google-analytics.com/g/collect?v=2", "fetch", false), "skip-resource");
  assert.equal(classifyBrowserRequest("https://connect.facebook.net/en_US/fbevents.js", "script", false), "skip-resource");
  assert.equal(classifyBrowserRequest("https://bidagent.xad.com/conv/286243", "xhr", false), "skip-resource");
  assert.equal(classifyBrowserRequest("https://www.googletagmanager.com/gtm.js?id=GTM-X", "script", false), "check-subresource");
  assert.equal(classifyBrowserRequest("https://cdn.dealerinspire.com/app.js", "script", false), "check-subresource");
  // A page the crawler was asked to open is never treated as a beacon.
  assert.equal(classifyBrowserRequest("https://www.doubleclick.net/", "document", true), "check-navigation");
});
