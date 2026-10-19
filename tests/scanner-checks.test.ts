import { test } from "node:test";
import assert from "node:assert/strict";
import type { PageDetails } from "@/lib/db/schema";
import { parsePage, normalizePhone, napAddress } from "@/lib/seo/parser";
import { evaluateScan, isConfirmedVdp, napConflicts, type EvalLink, type EvalPage, type EvalSite } from "@/lib/seo/checks/evaluate";
import { CHECKS, CHECKS_BY_KEY } from "@/lib/seo/checks/config";
import { computeScore } from "@/lib/seo/scoring";
import { classifyLinkRedirect } from "@/lib/seo/links";
import { hreflangCodeProblem, hreflangProblems } from "@/lib/seo/hreflang";

/**
 * The scanner-track checks: redirect chains, links to redirecting URLs,
 * hreflang, vehicle detail pages and NAP consistency. Each check is run on
 * realistic dealer markup and, as importantly, on the markup that must NOT
 * trigger it — dealer platforms are noisy, and a false finding in a client
 * report costs more than a missed one.
 */

const BASE = "https://www.example-dealer.com";
const VIN = "1HGCV1F34PA012345";

const site: EvalSite = {
  baseUrl: `${BASE}/`,
  siteAvailable: true,
  homepageStatus: 200,
  homepageErrorCode: null,
  robots: { found: true, blocksAll: false, blocksGooglebot: false, sitemaps: [`${BASE}/sitemap.xml`] },
  sitemap: { found: true, urlCount: 120 },
  importantPages: [],
};

function page(id: number, path: string, over: Partial<EvalPage> = {}): EvalPage {
  return {
    id,
    url: `${BASE}${path}`,
    finalUrl: `${BASE}${path}`,
    status: "fetched",
    pageType: path === "/" ? "home" : "other",
    isImportant: path === "/",
    httpStatus: 200,
    responseTimeMs: 400,
    htmlBytes: 60_000,
    title: `A clear descriptive page title for ${path.slice(1) || "the home page"}`,
    metaDescription: `A meta description for ${path} that comfortably clears the minimum length while staying under the maximum.`,
    h1: ["The single heading"],
    h2: ["A subheading"],
    canonical: `${BASE}${path}`,
    robotsMeta: null,
    xRobotsTag: null,
    lang: "en",
    hasViewport: true,
    wordCount: 600,
    internalLinksCount: 25,
    imagesCount: 8,
    imagesMissingAlt: 0,
    blockingScriptsCount: 1,
    schemaTypes: ["AutoDealer"],
    schemaErrors: 0,
    openGraph: { "og:title": "t", "og:description": "d", "og:image": "i" },
    errorCode: null,
    details: null,
    ...over,
  };
}

const issuesOf = (pages: EvalPage[], links: EvalLink[] = [], key?: string) => evaluateScan(pages, links, site).issues.filter((i) => !key || i.checkKey === key);
const checkOf = (pages: EvalPage[], key: string, links: EvalLink[] = []) => evaluateScan(pages, links, site).checks.find((c) => c.checkKey === key)!;

/* ─────────────────────────── Dealer markup fixtures ─────────────────────────── */

const chrome = (main: string, head = "") => `<!doctype html><html lang="en"><head><title>2024 Honda Accord EX | Example Honda</title>${head}</head>
<body>
  <header><a href="tel:+1-850-555-0100">Sales (850) 555-0100</a> <a href="tel:8505550111">Service</a>
    <nav><a href="/used-vehicles/?price=under-15000">Cars under $15,000</a><a href="/new-vehicles/">New</a></nav></header>
  <main>${main}</main>
  <footer>Example Honda · 1200 Main Street, Springfield · Parts (850) 555-0122 · Contact dealer for pricing details. Sold vehicles are removed daily.</footer>
</body></html>`;

const vehicleLd = (offers: Record<string, unknown> | null, extra: Record<string, unknown> = {}) =>
  `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "Car", name: "2024 Honda Accord EX", vehicleIdentificationNumber: VIN, ...(offers ? { offers } : {}), ...extra })}</script>`;

test("parser: Dealer.com-style VDP with Car schema and visible price", () => {
  const html = chrome(`<h1>2024 Honda Accord EX</h1><dl><dt>VIN</dt><dd>${VIN}</dd></dl><span class="price">$31,495</span>`, vehicleLd({ "@type": "Offer", price: "31495.00", priceCurrency: "USD", availability: "https://schema.org/InStock" }));
  const v = parsePage(html, `${BASE}/new/Honda/2024-Honda-Accord-${VIN}.htm`).vehicle;
  assert.equal(v.vin, VIN);
  assert.equal(v.hasVehicleSchema, true);
  assert.equal(v.schemaPrice, 31495);
  assert.equal(v.visiblePrice, true);
  assert.equal(v.availability, "InStock");
  assert.equal(v.soldText, false);
});

test("parser: a price only in the navigation (\"Cars under $15,000\") is not this vehicle's price", () => {
  const v = parsePage(chrome(`<h1>2024 Honda Accord EX</h1><p>VIN: ${VIN}</p><p>Great car.</p>`), `${BASE}/inventory/honda/accord/${VIN}`).vehicle;
  assert.equal(v.visiblePrice, false, "header/nav amounts are excluded");
  assert.equal(v.priceStatement, false, "the footer disclaimer \"Contact dealer for pricing details\" is excluded too");
  assert.equal(v.soldText, false, "\"Sold vehicles are removed daily\" in the footer is not a sold notice");
  assert.equal(v.vin, VIN, "labelled VIN in the text");
});

test("parser: explicit pricing statements, JavaScript-rendered prices and microdata", () => {
  assert.equal(parsePage(chrome(`<p>VIN ${VIN}</p><button>Call for Price</button>`), `${BASE}/vdp/1`).vehicle.priceStatement, true);
  assert.equal(parsePage(chrome(`<p>VIN ${VIN}</p><a>Unlock our best price</a>`), `${BASE}/vdp/1`).vehicle.priceStatement, true);
  assert.equal(parsePage(chrome(`<p>VIN ${VIN}</p><a>Get ePrice</a>`), `${BASE}/vdp/1`).vehicle.priceStatement, true);
  const js = parsePage(chrome(`<div id="app"></div><script>window.__VEHICLE__ = {"vin":"${VIN}","internetPrice":28950,"miles":12000};</script>`), `${BASE}/vdp/1`).vehicle;
  assert.equal(js.scriptPrice, true);
  const micro = parsePage(chrome(`<div itemscope itemtype="https://schema.org/Car"><div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="24999"><link itemprop="availability" href="https://schema.org/SoldOut"></div></div>`), `${BASE}/vdp/1`).vehicle;
  assert.equal(micro.hasVehicleSchema, true);
  assert.equal(micro.schemaPrice, 24999);
  assert.equal(micro.availability, "SoldOut");
});

test("parser: sold notices are recognised only as clear sentences", () => {
  assert.equal(parsePage(chrome(`<div class="alert">Sorry, this vehicle has been sold.</div>`), `${BASE}/vdp/1`).vehicle.soldText, true);
  assert.equal(parsePage(chrome(`<p>This vehicle is no longer available.</p>`), `${BASE}/vdp/1`).vehicle.soldText, true);
  // A similar-vehicles carousel with SOLD badges, and "offer no longer available", are not about this vehicle.
  assert.equal(parsePage(chrome(`<ul class="similar"><li>2023 Civic <span>SOLD</span></li></ul><p>Offer no longer available after 10/31.</p>`), `${BASE}/vdp/1`).vehicle.soldText, false);
});

test("parser: hreflang alternates are resolved; non-alternate links ignored", () => {
  const head = `<link rel="alternate" hreflang="en-us" href="/service/"><link rel="alternate" hreflang="es-us" href="https://es.example-dealer.com/service/"><link rel="alternate" hreflang="x-default" href="/service/"><link rel="canonical" href="/service/">`;
  const p = parsePage(chrome("<p>x</p>", head), `${BASE}/service/`);
  assert.deepEqual(p.hreflang.map((h) => h.lang), ["en-us", "es-us", "x-default"]);
  assert.equal(p.hreflang[0].href, `${BASE}/service/`);
  assert.deepEqual(parsePage(chrome("<p>no alternates</p>"), `${BASE}/`).hreflang, []);
});

test("parser: NAP from top-level dealer schema; departments' own numbers are not the dealership's", () => {
  const ld = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", name: "Example Honda", publisher: { "@type": "Organization", name: "Platform Vendor", telephone: "800-555-0199" } },
      {
        "@type": "AutoDealer",
        name: "Example Honda",
        telephone: "+1 (850) 555-0100",
        address: { "@type": "PostalAddress", streetAddress: "1200 Main Street", addressLocality: "Springfield", addressRegion: "FL", postalCode: "32401-1234" },
        department: [{ "@type": "AutoRepair", name: "Example Honda Service", telephone: "850-555-0111" }],
      },
    ],
  };
  const nap = parsePage(chrome("<p>x</p>", `<script type="application/ld+json">${JSON.stringify(ld)}</script>`), `${BASE}/`).nap!;
  assert.equal(nap.entities.length, 1, "nested publisher and departments are left out");
  assert.deepEqual(nap.entities[0], { name: "Example Honda", phone: "8505550100", address: "1200 Main Street, Springfield, FL 32401", addressKey: "1200|32401" });
  assert.ok(nap.visiblePhones.includes("8505550100") && nap.visiblePhones.includes("8505550111") && nap.visiblePhones.includes("8505550122"), "tel: links and header/footer numbers are kept as evidence");
  assert.equal(normalizePhone("850.555.0100 ext. 12"), "8505550100");
  assert.equal(napAddress("1200 Main St., Springfield, FL 32401").addressKey, "1200|32401", "a plain-string address gets the same key");
});

/* ─────────────────────────────── Redirects ─────────────────────────────── */

test("redirect_chain: two hops are flagged; one hop, no redirect and the homepage are not", () => {
  const chained = page(2, "/service/", { details: { redirectChain: [`http://example-dealer.com/service`, `https://example-dealer.com/service`] } });
  const single = page(3, "/finance/", { details: { redirectChain: [`${BASE}/finance`] } });
  const none = page(4, "/about/", { details: { redirectChain: [] } });
  // The homepage is requested at the address typed into the admin form, so its hops are not the site's.
  const home = page(1, "/", { details: { redirectChain: ["http://example-dealer.com/", "https://example-dealer.com/"] } });
  const issues = issuesOf([home, chained, single, none], [], "redirect_chain");
  assert.deepEqual(issues.map((i) => i.url), [`${BASE}/service/`]);
  assert.match(issues[0].message, /2 redirects: http:\/\/example-dealer\.com\/service → https:\/\/example-dealer\.com\/service → https:\/\/www\.example-dealer\.com\/service\//);
  assert.equal(checkOf([home, chained, single, none], "redirect_chain").applicable, 3);
  assert.equal(checkOf([page(1, "/"), page(2, "/x")], "redirect_chain").applicable, 0, "pages without stored redirect data (older scans) are not applicable");
});

test("classifyLinkRedirect: only stale paths and http:// links are worth updating", () => {
  assert.equal(classifyLinkRedirect(`${BASE}/new-vehicles`, `${BASE}/new-vehicles/`), "normalisation", "trailing slash");
  assert.equal(classifyLinkRedirect("https://example-dealer.com/service", `${BASE}/service`), "normalisation", "www");
  assert.equal(classifyLinkRedirect(`${BASE}/Service/`, `${BASE}/service/`), "normalisation", "letter case");
  assert.equal(classifyLinkRedirect("http://www.example-dealer.com/service", `${BASE}/service`), "https");
  assert.equal(classifyLinkRedirect(`${BASE}/service-specials.htm`, `${BASE}/specials/service/`), "moved");
  assert.equal(classifyLinkRedirect(`${BASE}/apply`, "https://lender.example.com/app"), "offsite");
  assert.equal(classifyLinkRedirect(`${BASE}/my-garage`, `${BASE}/login?return=/my-garage`), "ignored", "sign-in walls");
  assert.equal(classifyLinkRedirect(`${BASE}/inventory`, `${BASE}/inventory?session=abc`), "ignored", "query-only changes");
});

const link = (url: string, over: Partial<EvalLink> = {}): EvalLink => ({ url, isInternal: true, httpStatus: 200, errorCode: null, isBroken: false, foundOn: [`${BASE}/`], occurrences: 1, anchorText: "x", finalUrl: null, redirectHops: null, ...over });

test("internal_link_redirects: flags moved and http:// links, never normalisation, refusals or broken targets", () => {
  const pages = [page(1, "/"), page(2, "/service/"), page(3, "/finance/")];
  const links = [
    link(`${BASE}/service-specials.htm`, { finalUrl: `${BASE}/specials/service/`, redirectHops: 1, occurrences: 3, foundOn: [`${BASE}/`, `${BASE}/service/`, `${BASE}/finance/`] }),
    link("http://www.example-dealer.com/finance/", { finalUrl: `${BASE}/finance/`, redirectHops: 1 }),
    link(`${BASE}/new-vehicles`, { finalUrl: `${BASE}/new-vehicles/`, redirectHops: 1, occurrences: 40 }),
    link(`${BASE}/old-a`, { finalUrl: `${BASE}/new-a/`, httpStatus: 403, errorCode: "UNVERIFIABLE" }),
    link(`${BASE}/old-b`, { finalUrl: `${BASE}/gone/`, httpStatus: 404, isBroken: true }),
    link(`${BASE}/old-c`, { finalUrl: `${BASE}/new-c/`, errorCode: "ROBOTS_BLOCKED" }),
    link(`${BASE}/plain`),
  ];
  const issues = issuesOf(pages, links, "internal_link_redirects");
  assert.deepEqual(issues.map((i) => (i.details as { target: string }).target).sort(), ["http://www.example-dealer.com/finance/", `${BASE}/service-specials.htm`]);
  assert.ok(issues.every((i) => i.severity === "info"));
  const moved = issues.find((i) => (i.details as { target: string }).target.endsWith(".htm"))!;
  assert.match(moved.message, /redirects to https:\/\/www\.example-dealer\.com\/specials\/service\/\. Found on 3 pages\./);
});

test("internal_link_redirects: a link verified in an earlier scan (REUSED) keeps its finding, so it does not flap", () => {
  const issues = issuesOf([page(1, "/")], [link(`${BASE}/old`, { finalUrl: `${BASE}/new/`, errorCode: "REUSED" })], "internal_link_redirects");
  assert.equal(issues.length, 1);
});

/* ─────────────────────────────── hreflang ─────────────────────────────── */

test("hreflang codes: syntax plus the common mistakes", () => {
  for (const ok of ["en", "en-US", "es-us", "x-default", "zh-Hant-TW", "es-419", "fil"]) assert.equal(hreflangCodeProblem(ok), null, ok);
  assert.match(hreflangCodeProblem("en_US")!, /underscore.*"en-US"/);
  assert.match(hreflangCodeProblem("en-UK")!, /use "en-GB"/);
  assert.match(hreflangCodeProblem("us")!, /country, not a language/);
  assert.match(hreflangCodeProblem("english")!, /not a valid language code/);
});

const alt = (lang: string, path: string) => ({ lang, href: `${BASE}${path}` });

test("hreflang_invalid: a correct, reciprocal set passes; pages without hreflang are not applicable", () => {
  const set = [alt("en-US", "/service/"), alt("es-US", "/es/service/"), alt("x-default", "/service/")];
  const en = page(2, "/service/", { details: { hreflang: set } });
  const es = page(3, "/es/service/", { details: { hreflang: set } });
  assert.deepEqual(issuesOf([page(1, "/"), en, es], [], "hreflang_invalid"), []);
  assert.equal(checkOf([page(1, "/"), en, es], "hreflang_invalid").applicable, 2, "only the two pages that declare hreflang");
  assert.equal(checkOf([page(1, "/"), page(2, "/service/")], "hreflang_invalid").applicable, 0, "a US site with no hreflang is not penalised");
});

test("hreflang_invalid: invalid codes, no x-default and missing return links", () => {
  const en = page(2, "/service/", { details: { hreflang: [alt("en_US", "/service/"), alt("es-US", "/es/service/")] } });
  // The Spanish page was crawled and does not link back.
  const es = page(3, "/es/service/", { details: { hreflang: [alt("es-US", "/es/service/")] } });
  const enIssue = issuesOf([page(1, "/"), en, es], [], "hreflang_invalid").find((i) => i.url === `${BASE}/service/`)!;
  assert.match(enIssue.message, /underscore/);
  assert.match(enIssue.message, /no "x-default"/);
  assert.match(enIssue.message, /no return link from https:\/\/www\.example-dealer\.com\/es\/service\//);
  const noSelf = hreflangProblems({ url: `${BASE}/a`, finalUrl: null, canonical: null, hreflang: [alt("es-US", "/es/a")] }, () => undefined, (a, b) => a === b);
  assert.deepEqual(noSelf, ["the page does not list itself as one of the alternates"], "a single alternate needs no x-default; uncrawled targets are not checked for return links");
});

/* ─────────────────────────── Vehicle detail pages ─────────────────────────── */

type Vehicle = NonNullable<PageDetails["vehicle"]>;
const vehicle = (over: Partial<Vehicle> = {}): Vehicle => ({ vin: VIN, hasVehicleSchema: true, schemaPrice: 31495, visiblePrice: true, scriptPrice: false, priceStatement: false, availability: "InStock", soldText: false, ...over });
const vdp = (id: number, v: Partial<Vehicle> = {}, over: Partial<EvalPage> = {}) =>
  page(id, `/new/accord-${id}.htm`, { pageType: "vehicle_detail", schemaTypes: v.hasVehicleSchema === false ? ["BreadcrumbList"] : ["Car", "Offer"], details: { vehicle: vehicle(v) }, ...over });
const VDP_KEYS = ["vdp_price_missing", "vdp_schema_missing", "vdp_sold_indexed", "schema_missing"];
const vdpKeys = (pages: EvalPage[]) => issuesOf([page(1, "/"), ...pages]).filter((i) => VDP_KEYS.includes(i.checkKey)).map((i) => i.checkKey).sort();

test("VDP: a healthy vehicle page passes every vehicle check", () => {
  assert.deepEqual(vdpKeys([vdp(2)]), []);
});

test("VDP: listing pages that only look like VDPs by URL are not held to VDP rules", () => {
  // /inventory/new/toyota matches the VDP URL pattern but has no VIN and no vehicle schema.
  const srp = page(2, "/inventory/new/toyota", { pageType: "vehicle_detail", schemaTypes: [], details: { vehicle: vehicle({ vin: null, hasVehicleSchema: false, schemaPrice: null, visiblePrice: false }) } });
  assert.equal(isConfirmedVdp(srp), false);
  assert.deepEqual(vdpKeys([srp]), ["schema_missing"], "the ordinary schema check still applies");
  assert.equal(isConfirmedVdp(page(3, "/vdp/x", { pageType: "vehicle_detail" })), false, "older scans without vehicle facts are not applicable");
});

test("vdp_price_missing: no price anywhere is flagged; any price signal or an explicit statement passes", () => {
  const none = { schemaPrice: null, visiblePrice: false, scriptPrice: false, priceStatement: false };
  assert.deepEqual(vdpKeys([vdp(2, none)]), ["vdp_price_missing"]);
  assert.deepEqual(vdpKeys([vdp(2, { ...none, priceStatement: true })]), [], '"Call for price" is a deliberate pricing policy (MAP), not a defect');
  assert.deepEqual(vdpKeys([vdp(2, { ...none, scriptPrice: true })]), [], "a price rendered by JavaScript is still shown");
  assert.deepEqual(vdpKeys([vdp(2, { ...none, schemaPrice: 28000 })]), []);
  assert.deepEqual(vdpKeys([vdp(2, { ...none, visiblePrice: true })]), []);
  assert.deepEqual(vdpKeys([vdp(2, { ...none, soldText: true }, { robotsMeta: "noindex" })]), [], "a sold vehicle is not asked for a price");
});

test("vdp_schema_missing replaces schema_missing on vehicle pages, so nothing is counted twice", () => {
  assert.deepEqual(vdpKeys([vdp(2, { hasVehicleSchema: false }, { schemaTypes: [] })]), ["vdp_schema_missing"]);
  assert.deepEqual(vdpKeys([vdp(2, { hasVehicleSchema: false })]), ["vdp_schema_missing"], "breadcrumbs alone are not vehicle schema");
  assert.equal(checkOf([page(1, "/"), vdp(2)], "schema_missing").applicable, 1, "the VDP is not in schema_missing's denominator");
});

test("vdp_sold_indexed: only strong sold signals on an indexable 200 page", () => {
  assert.deepEqual(vdpKeys([vdp(2, { availability: "SoldOut" })]), ["vdp_sold_indexed"]);
  assert.deepEqual(vdpKeys([vdp(2, { availability: "Discontinued" })]), ["vdp_sold_indexed"]);
  assert.deepEqual(vdpKeys([vdp(2, { soldText: true })]), ["vdp_sold_indexed"]);
  assert.deepEqual(vdpKeys([vdp(2, { availability: "OutOfStock" })]), [], "out of stock / in transit is not sold");
  assert.deepEqual(vdpKeys([vdp(2, { availability: "SoldOut" }, { robotsMeta: "noindex, follow" })]), [], "noindex is the right handling");
  assert.deepEqual(vdpKeys([vdp(2, { availability: "SoldOut" }, { canonical: `${BASE}/new-vehicles/honda/accord/` })]), [], "canonical to the model page hands indexing elsewhere");
  assert.deepEqual(vdpKeys([vdp(2, { availability: "SoldOut" }, { httpStatus: 203 })]), [], "only a plain 200");
});

/* ─────────────────────────────── NAP ─────────────────────────────── */

const napPage = (id: number, path: string, entities: Array<{ name: string | null; phone: string | null; addressKey: string | null; address?: string }>) =>
  page(id, path, { details: { nap: { entities: entities.map((e) => ({ address: e.address ?? e.addressKey, ...e })), visiblePhones: [] } } });
const MAIN = { name: "Example Honda", phone: "8505550100", addressKey: "1200|32401", address: "1200 Main Street, Springfield, FL 32401" };

test("nap_inconsistent: consistent schema across pages passes; one page alone is not applicable", () => {
  const pages = [napPage(1, "/", [MAIN]), napPage(2, "/service/", [{ ...MAIN, name: "Example Honda, LLC" }]), napPage(3, "/finance/", [MAIN])];
  assert.deepEqual(issuesOf(pages, [], "nap_inconsistent"), []);
  assert.equal(checkOf(pages, "nap_inconsistent").applicable, 1);
  assert.equal(checkOf([napPage(1, "/", [MAIN]), page(2, "/service/")], "nap_inconsistent").applicable, 0);
});

test("nap_inconsistent: a different schema phone or address for the same dealership is flagged once each", () => {
  const pages = [napPage(1, "/", [MAIN]), napPage(2, "/service/", [{ ...MAIN, phone: "8505550111" }]), napPage(3, "/about/", [{ ...MAIN, addressKey: "1250|32401", address: "1250 Main Street, Springfield, FL 32401" }])];
  const issues = issuesOf(pages, [], "nap_inconsistent");
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.url === `${BASE}/` && i.pageId === null), "a site-level finding");
  assert.ok(issues.some((i) => /2 different phone numbers.*\(850\) 555-0100.*\(850\) 555-0111/.test(i.message)));
  assert.ok(issues.some((i) => /2 different addresses/.test(i.message)));
  assert.deepEqual(issuesOf([...pages].reverse(), [], "nap_inconsistent").map((i) => i.message), issues.map((i) => i.message), "page order does not change the finding");
});

test("nap_inconsistent: separate rooftops, departments and unnamed entities are not conflicts", () => {
  const otherStore = { name: "Example Toyota", phone: "8505550200", addressKey: "300|32405" };
  assert.deepEqual(napConflicts([napPage(1, "/", [MAIN]), napPage(2, "/locations/toyota/", [otherStore])]), []);
  assert.deepEqual(napConflicts([napPage(1, "/", [MAIN]), napPage(2, "/service/", [{ name: "Example Honda Service Center", phone: "8505550111", addressKey: "1200|32401" }])]), []);
  assert.deepEqual(napConflicts([napPage(1, "/", [{ ...MAIN, name: null }]), napPage(2, "/x/", [{ ...MAIN, name: null, phone: "8505550111" }])]), []);
});

test("scan engine: redirect targets are recorded by link checks, inherited from crawled pages and kept by link reuse", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/lib/seo/scan-engine.ts", import.meta.url), "utf8");
  assert.ok(src.includes("res.redirected && res.finalUrl ? { finalUrl: res.finalUrl.slice(0, 2000), redirectHops: res.redirectChain.length || 1 }"), "headers-only link checks store the final URL");
  assert.ok(src.includes("and p.url = l.url and p.redirected and p.final_url is not null"), "a link to a page the crawl saw redirect inherits it without a second request");
  assert.ok(src.includes("final_url = prev.final_url, redirect_hops = prev.redirect_hops"), "reused link results keep their redirect, so the finding does not flap");
  assert.ok(src.includes("...(pageType === \"vehicle_detail\" ? { vehicle: parsed.vehicle } : {})"), "vehicle facts are stored only for VDPs");
});

/* ─────────────────────────── Catalogue & score impact ─────────────────────────── */

test("the catalogue has the seven scanner-track checks with modest points", () => {
  const added = { redirect_chain: 3, internal_link_redirects: 2, hreflang_invalid: 3, vdp_price_missing: 2, vdp_schema_missing: 4, vdp_sold_indexed: 3, nap_inconsistent: 3 };
  assert.equal(CHECKS.length, 46);
  for (const [key, points] of Object.entries(added)) assert.equal(CHECKS_BY_KEY[key]?.points, points, key);
});

test("score impact: a clean site stays at 100, and a site failing every new check loses a bounded amount", () => {
  const clean = [page(1, "/", { details: { redirectChain: [], nap: { entities: [MAIN], visiblePhones: [] } } }), napPage(2, "/service/", [MAIN]), vdp(3)];
  assert.equal(computeScore(evaluateScan(clean, [], site).checks).score, 100);
  const bad = [
    page(1, "/", { details: { nap: { entities: [MAIN], visiblePhones: [] } } }),
    page(2, "/service/", { details: { redirectChain: ["http://a.example-dealer.com/s", "https://example-dealer.com/s"], hreflang: [alt("en_US", "/service/"), alt("es", "/es/")], nap: { entities: [{ ...MAIN, phone: "8505550111" }], visiblePhones: [] } } }),
    vdp(3, { hasVehicleSchema: false, schemaPrice: null, visiblePrice: false, soldText: false }),
    vdp(4, { availability: "SoldOut" }),
  ];
  const links = [link(`${BASE}/old`, { finalUrl: `${BASE}/new/`, occurrences: 4, foundOn: [`${BASE}/`, `${BASE}/service/`] })];
  const score = computeScore(evaluateScan(bad, links, site).checks).score;
  assert.ok(score >= 88 && score < 100, `worst case for the new checks alone should cost about a dozen points at most, got ${score}`);
});
