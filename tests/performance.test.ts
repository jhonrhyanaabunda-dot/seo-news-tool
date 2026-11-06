import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { carryScoresForward } from "@/lib/queries/portfolio-trend";
import { omitColumns } from "@/lib/queries/columns";
import { scanPhaseText } from "@/lib/seo/scan-phase";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("the portfolio line carries each dealership's latest score forward and averages per day", () => {
  const line = carryScoresForward("2026-10-01", "2026-10-04", [
    { dealershipId: 1, day: "2026-10-01", score: 80 },
    { dealershipId: 2, day: "2026-10-02", score: 61 },
    { dealershipId: 1, day: "2026-10-04", score: 90 },
  ]);
  assert.deepEqual(line, [
    { day: "2026-10-01", score: 80, dealerships: 1 },
    { day: "2026-10-02", score: 71, dealerships: 2 },
    { day: "2026-10-03", score: 71, dealerships: 2 },
    { day: "2026-10-04", score: 76, dealerships: 2 },
  ]);
});

test("the portfolio line skips days before anyone has a score, and crosses month ends by calendar day", () => {
  assert.deepEqual(carryScoresForward("2026-10-01", "2026-10-02", []), []);
  assert.deepEqual(carryScoresForward("2026-10-31", "2026-11-02", [{ dealershipId: 1, day: "2026-11-02", score: 70 }]), [{ day: "2026-11-02", score: 70, dealerships: 1 }]);
  const days = carryScoresForward("2026-10-30", "2026-11-03", [{ dealershipId: 1, day: "2026-10-30", score: 70 }]).map((d) => d.day);
  assert.deepEqual(days, ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
});

test("omitColumns leaves everything else, and leaves its input alone", () => {
  const cols = { a: 1, b: 2, c: 3 };
  assert.deepEqual(omitColumns(cols, "b"), { a: 1, c: 3 });
  assert.deepEqual(cols, { a: 1, b: 2, c: 3 });
});

test("the scan banner words progress the same on the server and in live updates", () => {
  assert.equal(scanPhaseText("queued", null, { done: 0, total: 0 }), "waiting for the crawler to start");
  assert.equal(scanPhaseText("finalizing", "finalize", { done: 9, total: 9 }), "calculating results");
  assert.equal(scanPhaseText("crawling", "links", { done: 9, total: 9 }), "checking links (9 pages crawled)");
  assert.equal(scanPhaseText("crawling", "crawl", { done: 0, total: 0 }), "loading the homepage");
  assert.equal(scanPhaseText("crawling", "crawl", { done: 3, total: 9 }), "3 of 9 pages checked");
});

test("/news runs one query for every dealership's articles, not one per dealership", () => {
  const news = read("src/lib/queries/news.ts");
  const fn = news.slice(news.indexOf("export async function getNewsByDealership"), news.indexOf("export async function getReviewQueue"));
  assert.ok(fn.includes("row_number() over (partition by"));
  assert.ok(!fn.includes("getNews("), "no per-dealership query");
});

test("the scan status endpoint checks the session and the dealership before reading anything", () => {
  const route = read("src/app/api/dealerships/[id]/scan-status/route.ts");
  const session = route.indexOf("getCurrentUser()");
  const access = route.indexOf("canAccessDealership(user, dealershipId)");
  const scan = route.indexOf("getLatestScanAttempt(dealershipId)");
  assert.ok(session > 0 && session < access && access < scan);
  assert.ok(route.includes("{ status: 404 }"), "someone else's dealership looks like a missing one");
});

test("the scan banner polls the status endpoint and only re-renders the page when it changes", () => {
  const client = read("src/components/client/scan-auto-refresh.tsx");
  assert.ok(client.includes("/scan-status"));
  assert.equal((client.match(/router\.refresh\(\)/g) ?? []).length, 2, "when the scan ends, and when it stalls or recovers");
});

test("tab content streams under the dealership layout's authorisation", () => {
  assert.ok(read("src/app/(app)/dealerships/[id]/page.tsx").includes("<Suspense key={tab}"));
  assert.ok(read("src/app/(app)/dealerships/[id]/layout.tsx").includes("requireDealershipAccess"), "the 404 is decided before anything streams");
});

test("no loading boundary is added above a page that does its own access check", () => {
  assert.equal(existsSync(new URL("../src/app/report/[id]/loading.tsx", import.meta.url)), false);
});
