import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildJwtAssertion, GoogleApiError, GoogleTokenCache, GOOGLE_TOKEN_URL, normalizePrivateKey, parseServiceAccount, tokenErrorMessage } from "@/lib/integrations/google-auth";
import { addDays, comparePeriods, GSC_HISTORY_DAYS, gscApiError, pacificDate, parseSearchAnalytics, pctChange, searchAnalyticsRequest, searchAnalyticsUrl, syncWindow, totals, validateGscProperty, weeklySeries } from "@/lib/integrations/gsc";
import { listingFlags, matchCandidateByHost, normalizePlaceId, parsePlaceDetails, parseTextSearch, placesApiError, placeSearchQuery, reviewChange } from "@/lib/integrations/places";
import { comparisonRows, emptyMetrics, metricsFromPage, metricsFromScanPage } from "@/lib/integrations/competitor-metrics";
import { createGscClient, createPlacesClient } from "@/lib/integrations/clients";
import { parseIntegrationFields } from "@/lib/integrations/form";
import { parsePage } from "@/lib/seo/parser";
import { findingNumbers, ungroundedNumbers } from "@/lib/reports/ground";
import type { ReportFindings } from "@/lib/reports/types";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
const account = { clientEmail: "monitor@a3-seo.iam.gserviceaccount.com", privateKey };
const SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

/* ─────────────── Service account & JWT ─────────────── */

test("service account credentials are read from JSON, base64 JSON or the escaped two-variable form", () => {
  const json = JSON.stringify({ type: "service_account", client_email: account.clientEmail, private_key: privateKey });
  const a = parseServiceAccount({ json });
  assert.ok(a.ok && a.account.clientEmail === account.clientEmail && a.account.privateKey === privateKey.trim());
  const b = parseServiceAccount({ json: Buffer.from(json).toString("base64") });
  assert.ok(b.ok && b.account.privateKey === privateKey.trim());
  // Vercel/.env values usually carry the key on one line with literal "\n".
  const escaped = privateKey.replace(/\n/g, "\\n");
  const c = parseServiceAccount({ email: account.clientEmail, privateKey: `"${escaped}"` });
  assert.ok(c.ok && c.account.privateKey === privateKey.trim());
  assert.equal(normalizePrivateKey("a\\nb"), "a\nb");
});

test("missing credentials are 'not configured'; mistakes get a readable reason without the key", () => {
  assert.deepEqual(parseServiceAccount({}), { ok: false, reason: null });
  const half = parseServiceAccount({ email: account.clientEmail });
  assert.ok(!half.ok && half.reason && /both/.test(half.reason));
  const oauth = parseServiceAccount({ json: JSON.stringify({ web: { client_id: "x" } }) });
  assert.ok(!oauth.ok && /service account key/.test(oauth.reason!));
  const bad = parseServiceAccount({ json: "{not json" });
  assert.ok(!bad.ok && /not valid JSON/.test(bad.reason!));
  const notPem = parseServiceAccount({ email: account.clientEmail, privateKey: "secret-value-123" });
  assert.ok(!notPem.ok && !notPem.reason!.includes("secret-value-123"));
});

test("the JWT assertion is a valid RS256 token with the right claims", () => {
  const jwt = buildJwtAssertion(account, SCOPE, 1_800_000_000);
  const [h, c, sig] = jwt.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(c, "base64url").toString());
  assert.deepEqual(claims, { iss: account.clientEmail, scope: SCOPE, aud: GOOGLE_TOKEN_URL, iat: 1_800_000_000, exp: 1_800_003_600 });
  const v = createVerify("RSA-SHA256");
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig, "base64url")));
});

function jsonResponse(status: number, body: unknown) {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("access tokens are cached until shortly before expiry, and concurrent callers share one request", async () => {
  let now = 1_000_000;
  const calls: Array<{ url: string; body: string }> = [];
  const cache = new GoogleTokenCache(
    async (url, init) => {
      calls.push({ url, body: String(init?.body) });
      return jsonResponse(200, { access_token: `tok-${calls.length}`, expires_in: 3600, token_type: "Bearer" });
    },
    () => now,
  );
  const [a, b] = await Promise.all([cache.getAccessToken(account, SCOPE), cache.getAccessToken(account, SCOPE)]);
  assert.equal(a, "tok-1");
  assert.equal(b, "tok-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, GOOGLE_TOKEN_URL);
  assert.match(calls[0].body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=/);
  now += 3000_000; // 50 minutes: still valid
  assert.equal(await cache.getAccessToken(account, SCOPE), "tok-1");
  now += 560_000; // under a minute left: refresh
  assert.equal(await cache.getAccessToken(account, SCOPE), "tok-2");
  cache.invalidate(account, SCOPE);
  assert.equal(await cache.getAccessToken(account, SCOPE), "tok-3");
});

test("token endpoint errors are readable, never contain the key, and classify retryability", async () => {
  const cache = new GoogleTokenCache(async () => jsonResponse(400, { error: "invalid_grant", error_description: "Invalid JWT Signature." }));
  await assert.rejects(cache.getAccessToken(account, SCOPE), (err: unknown) => {
    assert.ok(err instanceof GoogleApiError);
    assert.equal(err.permanent, true);
    assert.match(err.message, /invalid_grant: Invalid JWT Signature/);
    assert.ok(!err.message.includes("PRIVATE KEY"));
    return true;
  });
  assert.equal(tokenErrorMessage(503, "oops").permanent, false);
  const down = new GoogleTokenCache(async () => {
    throw new Error("ECONNRESET");
  });
  await assert.rejects(down.getAccessToken(account, SCOPE), (err: unknown) => err instanceof GoogleApiError && !err.permanent);
});

/* ─────────────── Search Console ─────────────── */

test("Search Console properties are validated and normalised", () => {
  assert.deepEqual(validateGscProperty("sc-domain:Example.com"), { ok: true, value: "sc-domain:example.com" });
  assert.deepEqual(validateGscProperty("https://www.Example.com"), { ok: true, value: "https://www.example.com/" });
  assert.deepEqual(validateGscProperty("https://www.example.com/used/"), { ok: true, value: "https://www.example.com/used/" });
  assert.equal(validateGscProperty("sc-domain:https://example.com").ok, false);
  assert.equal(validateGscProperty("example.com").ok, false);
  assert.equal(validateGscProperty("https://example.com/?x=1").ok, false);
  assert.equal(validateGscProperty("ftp://example.com/").ok, false);
});

test("sync window: 16 months on first sync, then incremental with a refresh overlap", () => {
  const first = syncWindow("2026-10-16", null);
  assert.deepEqual(first, { startDate: addDays("2026-10-15", -GSC_HISTORY_DAYS), endDate: "2026-10-15", initial: true });
  const next = syncWindow("2026-10-16", "2026-10-13");
  assert.deepEqual(next, { startDate: "2026-10-03", endDate: "2026-10-15", initial: false });
  assert.equal(pacificDate(new Date("2026-10-16T05:00:00Z")), "2026-10-15"); // still the 15th in California
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("Search Analytics responses are parsed defensively", () => {
  const rows = parseSearchAnalytics({
    rows: [
      { keys: ["2026-10-01"], clicks: 12, impressions: 340, ctr: 0.0353, position: 8.2 },
      { keys: ["2026-10-02"], clicks: "x", impressions: 10 },
      { clicks: 1, impressions: 2 },
      { keys: ["2026-10-03"], clicks: 0, impressions: 50, position: 0 },
    ],
  });
  assert.deepEqual(rows, [
    { key: "2026-10-01", clicks: 12, impressions: 340, ctr: 0.0353, position: 8.2 },
    { key: "2026-10-03", clicks: 0, impressions: 50, ctr: 0, position: null },
  ]);
  assert.deepEqual(parseSearchAnalytics({}), []);
  assert.equal(searchAnalyticsUrl("sc-domain:example.com"), "https://searchconsole.googleapis.com/webmasters/v3/sites/sc-domain%3Aexample.com/searchAnalytics/query");
  assert.deepEqual(searchAnalyticsRequest("2026-01-01", "2026-01-28", "query", 25), { startDate: "2026-01-01", endDate: "2026-01-28", dimensions: ["query"], type: "web", rowLimit: 25 });
});

test("a 403 tells the admin exactly which account to add; quota errors are retried", () => {
  const e = gscApiError(403, JSON.stringify({ error: { message: "User does not have sufficient permission" } }), "monitor@x.iam.gserviceaccount.com");
  assert.equal(e.permanent, true);
  assert.match(e.message, /add monitor@x\.iam\.gserviceaccount\.com as a user/);
  assert.equal(gscApiError(429, "", "a@b.c").permanent, false);
  assert.equal(gscApiError(500, "", "a@b.c").permanent, false);
  assert.equal(gscApiError(404, "", "a@b.c").permanent, true);
});

test("28-day totals use impression-weighted position, count missing days as zero, and compare with the previous 28 days", () => {
  const points = [];
  for (let i = 0; i < 56; i++) {
    const date = addDays("2026-08-20", i);
    // Previous period: 10 clicks/day; current: 15 clicks/day, with one missing day.
    if (date === "2026-10-01") continue;
    points.push({ date, clicks: i < 28 ? 10 : 15, impressions: 100, position: i < 28 ? 10 : 8 });
  }
  const end = addDays("2026-08-20", 55);
  const c = comparePeriods(points, end, null);
  assert.equal(c.periodStart, addDays(end, -27));
  assert.equal(c.current.clicks, 27 * 15);
  assert.equal(c.current.impressions, 2700);
  assert.equal(c.current.position, 8);
  assert.equal(c.previous!.clicks, 280);
  assert.ok(Math.abs(c.current.ctr - 405 / 2700) < 1e-9);
  assert.equal(Math.round(pctChange(c.current.clicks, c.previous!.clicks)!), 45);
  // Weighted, not a plain average of daily positions.
  assert.equal(totals([{ date: "a", clicks: 0, impressions: 900, position: 2 }, { date: "b", clicks: 0, impressions: 100, position: 12 }]).position, 3);
  // Without history for the earlier period there is no comparison rather than a fake drop from zero.
  assert.equal(comparePeriods(points.slice(30), end, null).previous, null);
  assert.equal(pctChange(10, 0), null);
});

test("weekly series sums whole weeks and skips weeks before the history starts", () => {
  const points = Array.from({ length: 21 }, (_, i) => ({ date: addDays("2026-09-01", i), clicks: 1, impressions: 10, position: 5 }));
  const w = weeklySeries(points, "2026-09-21", 5, "2026-09-01");
  assert.deepEqual(w, [
    { weekEnd: "2026-09-07", clicks: 7, impressions: 70 },
    { weekEnd: "2026-09-14", clicks: 7, impressions: 70 },
    { weekEnd: "2026-09-21", clicks: 7, impressions: 70 },
  ]);
});

test("the Search Console client sends the bearer token and re-signs once after a 401", async () => {
  const seen: Array<{ url: string; auth?: string; body?: string }> = [];
  let tokenCalls = 0;
  const fetchImpl = async (url: string, init?: RequestInit) => {
    if (url === GOOGLE_TOKEN_URL) {
      tokenCalls++;
      return jsonResponse(200, { access_token: `t${tokenCalls}`, expires_in: 3600 });
    }
    const auth = (init?.headers as Record<string, string>).Authorization;
    seen.push({ url, auth, body: String(init?.body) });
    if (auth === "Bearer t1") return jsonResponse(401, { error: { message: "expired" } });
    return jsonResponse(200, { rows: [{ keys: ["used cars near me"], clicks: 4, impressions: 90, ctr: 0.044, position: 6.1 }] });
  };
  const client = createGscClient({ account, tokens: new GoogleTokenCache(fetchImpl), fetchImpl });
  const rows = await client.query("sc-domain:example.com", searchAnalyticsRequest("2026-09-01", "2026-09-28", "query", 25));
  assert.equal(rows[0].key, "used cars near me");
  assert.equal(tokenCalls, 2);
  assert.deepEqual(seen.map((s) => s.auth), ["Bearer t1", "Bearer t2"]);
  assert.equal(JSON.parse(seen[1].body!).rowLimit, 25);
});

/* ─────────────── Places ─────────────── */

const DETAILS = {
  id: "ChIJN1t_tDeuEmsRUsoyG83frY4",
  displayName: { text: "Coastal Toyota", languageCode: "en" },
  rating: 4.6,
  userRatingCount: 1287,
  businessStatus: "OPERATIONAL",
  regularOpeningHours: { weekdayDescriptions: ["Monday: 9:00 AM – 8:00 PM"] },
  websiteUri: "https://www.coastaltoyota.com/?utm_source=gmb",
  nationalPhoneNumber: "(850) 555-0100",
  formattedAddress: "1 Main St, Pensacola, FL 32501, USA",
  googleMapsUri: "https://maps.google.com/?cid=1",
};

test("Place Details are parsed into a compact snapshot", () => {
  const d = parsePlaceDetails(DETAILS, "ChIJN1t_tDeuEmsRUsoyG83frY4");
  assert.equal(d.rating, 4.6);
  assert.equal(d.reviewCount, 1287);
  assert.equal(d.businessStatus, "OPERATIONAL");
  assert.deepEqual(d.data, {
    placeId: "ChIJN1t_tDeuEmsRUsoyG83frY4",
    name: "Coastal Toyota",
    formattedAddress: "1 Main St, Pensacola, FL 32501, USA",
    websiteUri: "https://www.coastaltoyota.com/?utm_source=gmb",
    nationalPhoneNumber: "(850) 555-0100",
    googleMapsUri: "https://maps.google.com/?cid=1",
    hasOpeningHours: true,
  });
  const empty = parsePlaceDetails({ rating: 9 }, "ChIJabcdefghijk");
  assert.equal(empty.rating, null);
  assert.equal(empty.data.placeId, "ChIJabcdefghijk");
  assert.equal(empty.data.hasOpeningHours, false);
});

test("listing flags: website host mismatch, closed business, missing hours — www and tracking ignored", () => {
  const ok = parsePlaceDetails(DETAILS, "x");
  assert.deepEqual(listingFlags(ok, "coastaltoyota.com"), []);
  const flags = listingFlags({ businessStatus: "CLOSED_TEMPORARILY", data: { ...ok.data, websiteUri: "https://www.dealer-platform.com/coastal", hasOpeningHours: false } }, "coastaltoyota.com");
  assert.deepEqual(flags.map((f) => f.key), ["not_operational", "website_mismatch", "no_hours"]);
  assert.match(flags[0].message, /temporarily closed/);
  assert.deepEqual(listingFlags({ businessStatus: "OPERATIONAL", data: { ...ok.data, websiteUri: null } }, "coastaltoyota.com").map((f) => f.key), ["no_website"]);
});

test("review change compares with the snapshot closest to 30 days earlier", () => {
  const day = (d: number) => new Date(Date.UTC(2026, 9, 16) - d * 86_400_000);
  const snaps = [0, 7, 14, 21, 28, 35].map((d) => ({ capturedAt: day(d), reviewCount: 1000 - d, rating: d >= 28 ? 4.5 : 4.6 }));
  const c = reviewChange(snaps)!;
  assert.equal(c.reviews, 28);
  assert.equal(c.rating, 0.1);
  assert.equal(c.since.getTime(), day(28).getTime());
  // Only a week of history: no "30-day" change is invented.
  assert.equal(reviewChange(snaps.slice(0, 2)), null);
});

test("text search results, place ids and the search query", () => {
  const r = parseTextSearch({ places: [{ id: "ChIJ1234567890", displayName: { text: "A" }, websiteUri: "http://www.a-motors.com/" }, { id: "bad id!" }] });
  assert.equal(r.length, 1);
  assert.equal(matchCandidateByHost(r, "a-motors.com")?.id, "ChIJ1234567890");
  assert.equal(matchCandidateByHost(r, "b-motors.com"), null);
  assert.equal(normalizePlaceId("places/ChIJ1234567890"), "ChIJ1234567890");
  assert.equal(normalizePlaceId("https://maps.google.com"), null);
  assert.equal(placeSearchQuery({ name: "Coastal Toyota", city: "Pensacola", state: "FL" }), "Coastal Toyota, Pensacola, FL");
  assert.equal(placesApiError(403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "API not enabled" } })).permanent, true);
  assert.equal(placesApiError(429, "").permanent, false);
});

test("the Places client sends the key and field mask as headers, never in the URL", async () => {
  const seen: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const places = createPlacesClient({
    apiKey: "KEY-123",
    fetchImpl: async (url, init) => {
      seen.push({ url, headers: init?.headers as Record<string, string>, body: init?.body as string | undefined });
      return jsonResponse(200, url.endsWith(":searchText") ? { places: [DETAILS] } : DETAILS);
    },
  });
  const d = await places.details("ChIJN1t_tDeuEmsRUsoyG83frY4");
  assert.equal(d.reviewCount, 1287);
  const found = await places.search("Coastal Toyota, Pensacola");
  assert.equal(found[0].name, "Coastal Toyota");
  assert.equal(seen[0].url, "https://places.googleapis.com/v1/places/ChIJN1t_tDeuEmsRUsoyG83frY4");
  assert.ok(!seen.some((s) => s.url.includes("KEY-123")));
  assert.equal(seen[0].headers["X-Goog-Api-Key"], "KEY-123");
  assert.ok(seen[0].headers["X-Goog-FieldMask"].split(",").includes("userRatingCount"));
  assert.ok(!seen[0].headers["X-Goog-FieldMask"].includes("reviews,"), "individual reviews are not requested");
  assert.deepEqual(JSON.parse(seen[1].body!), { textQuery: "Coastal Toyota, Pensacola", pageSize: 5 });
  const failing = createPlacesClient({ apiKey: "k", fetchImpl: async () => jsonResponse(404, { error: { status: "NOT_FOUND", message: "Not found" } }) });
  await assert.rejects(failing.details("ChIJ1234567890"), (e: unknown) => e instanceof GoogleApiError && e.permanent && /Find place/.test(e.message));
});

/* ─────────────── Competitors ─────────────── */

test("competitor metrics come from the parsed homepage", () => {
  const html = `<!doctype html><html><head><title>Coastal Toyota | New & Used Toyota Dealer in Pensacola</title>
    <meta name="description" content="Shop new and used Toyota vehicles at Coastal Toyota in Pensacola, FL. Service, parts and financing.">
    <meta name="viewport" content="width=device-width">
    <script type="application/ld+json">{"@context":"https://schema.org","@type":"AutoDealer","name":"Coastal Toyota"}</script>
    </head><body><h1>Coastal Toyota</h1></body></html>`;
  const page = parsePage(html, "https://www.coastaltoyota.com/");
  const m = metricsFromPage(page, { status: 200, finalUrl: "https://www.coastaltoyota.com/", bytes: html.length, totalMs: 820 });
  assert.equal(m.https, true);
  assert.equal(m.h1Present, true);
  assert.equal(m.dealerSchema, true);
  assert.deepEqual(m.schemaTypes, ["AutoDealer"]);
  assert.equal(m.mobileViewport, true);
  assert.equal(m.titleLength, "Coastal Toyota | New & Used Toyota Dealer in Pensacola".length);
  assert.equal(m.responseMs, 820);
  assert.equal(m.rating, null);
});

test("the comparison table shows dashes for blocked or unchecked competitors and no overall score", () => {
  const dealer = metricsFromScanPage(
    { httpStatus: 200, finalUrl: null, url: "http://dealer.com/", title: null, metaDescription: "x".repeat(120), h1: [], schemaTypes: ["Organization"], htmlBytes: 2 * 1024 * 1024, responseTimeMs: 4200, hasViewport: true },
    { rating: 4.2, reviewCount: 310, performance: 41 },
  );
  const rows = comparisonRows([dealer, null, { ...emptyMetrics(), rating: 4.8, reviewCount: 900 }]);
  const row = (k: string) => rows.find((r) => r.key === k)!;
  assert.deepEqual(row("https").cells.map((c) => c.text), ["No", "—", "—"]);
  assert.equal(row("title").cells[0].text, "Missing");
  assert.equal(row("description").cells[0].tone, "good");
  assert.equal(row("h1").cells[0].text, "No");
  assert.equal(row("dealer_schema").cells[0].text, "Yes");
  assert.equal(row("weight").cells[0].tone, "bad");
  assert.equal(row("response").cells[0].text, "4.2 s");
  assert.equal(row("performance").cells[0].text, "41/100");
  // A blocked competitor can still show its Google listing figures.
  assert.equal(row("reviews").cells[2].text, "900");
  assert.ok(!rows.some((r) => /score/i.test(r.label)), "no competitor SEO score");
  // Pruned scan details: unknown, not "missing".
  assert.equal(comparisonRows([metricsFromScanPage(null, { rating: null, reviewCount: null, performance: null })])[1].cells[0].text, "—");
});

/* ─────────────── Form & reports ─────────────── */

test("form fields: validated, optional, and absent fields leave stored values alone", () => {
  const fd = (o: Record<string, string>) => ({ get: (k: string) => (k in o ? o[k] : null) });
  assert.deepEqual(parseIntegrationFields(fd({ gscProperty: " sc-domain:dealer.com ", googlePlaceId: "places/ChIJ1234567890" })), { ok: true, data: { gscProperty: "sc-domain:dealer.com", googlePlaceId: "ChIJ1234567890" } });
  assert.deepEqual(parseIntegrationFields(fd({ gscProperty: "", googlePlaceId: "" })), { ok: true, data: { gscProperty: null, googlePlaceId: null } });
  assert.deepEqual(parseIntegrationFields(fd({})), { ok: true, data: {} });
  const bad = parseIntegrationFields(fd({ gscProperty: "dealer.com", googlePlaceId: "no" }));
  assert.ok(!bad.ok && bad.errors.gscProperty && bad.errors.googlePlaceId);
});

test("report grounding accepts Search Console and listing figures but not their dates", () => {
  const findings = {
    version: 2,
    dealership: { id: 1, name: "D", websiteUrl: "https://d.com/", brand: "Toyota", location: null, platform: null },
    scan: { id: 1, completedAt: null, status: "COMPLETED", outcomeLabel: "Completed", score: 80, categoryScores: [], pagesRequested: 10, pagesAnalyzed: 10, pagesProtected: 0, siteAvailable: true, limitedHomepageCheckOnly: false },
    counts: { critical: 0, high: 0, medium: 0, low: 0, passedChecks: 0 },
    issues: [],
    passedChecks: [],
    protectedPages: { total: 0, items: [] },
    changes: null,
    performance: null,
    searchConsole: { periodStart: "2026-09-16", periodEnd: "2026-10-13", clicks: 1234, impressions: 56789, ctrPct: 2.2, position: 11.4, previous: { clicks: 1100, impressions: 50000, ctrPct: 2.2, position: 12.1 } },
    googleListing: { rating: 4.6, reviewCount: 1287, capturedOn: "2026-10-12" },
    news: { periodDays: 30, newCount: 0, relevantCount: 0, dealership: [], manufacturer: [], industry: [] },
  } as ReportFindings;
  const allowed = findingNumbers(findings);
  assert.deepEqual(ungroundedNumbers("Google search brought 1,234 clicks from 56,789 impressions, up from 1,100; the listing has 1,287 reviews at 4.6 stars.", allowed), []);
  // Digits of the period dates must not make an invented "16 clicks" look grounded.
  assert.deepEqual(ungroundedNumbers("Only 16 clicks came in.", allowed), [16]);
});

test("integration jobs are claimable by every runner type, low priority, and kept out of the SEO score", () => {
  const runner = readFileSync("src/lib/jobs/runner.ts", "utf8");
  for (const t of ["gsc_sync", "places_sync", "competitor_audit"]) assert.ok(runner.includes(`"${t}"`));
  const scoring = readFileSync("src/lib/seo/scoring.ts", "utf8") + readFileSync("src/lib/seo/checks/evaluate.ts", "utf8");
  assert.ok(!/integrations|searchConsole|googleListing|competitor/i.test(scoring));
  const sync = readFileSync("src/lib/integrations/sync.ts", "utf8");
  assert.ok(/renderMode: "never"/.test(sync), "competitor audits never use the browser fallback");
  assert.ok(/robots\.blocksMonitor/.test(sync), "robots.txt is honoured for competitors");
});
