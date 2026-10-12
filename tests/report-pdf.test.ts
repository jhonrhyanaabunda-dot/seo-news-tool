import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { looksLikePdf, reportFilename } from "@/lib/reports/pdf-format";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/**
 * The PDF path turns a browser loose on a URL and streams whatever comes back,
 * so the two things worth pinning are: the worker can only ever open our own
 * report, and nothing but a real PDF reaches a download. Everything else is
 * covered end to end by scripts/verify-report-pdf.ts against a live server.
 */

test("only a real PDF is accepted", () => {
  assert.ok(looksLikePdf(Buffer.from("%PDF-1.7\nbody")));
  assert.ok(!looksLikePdf(Buffer.alloc(0)), "empty output is a failure, not a document");
  assert.ok(!looksLikePdf(Buffer.from("<!doctype html><html>")), "a sign-in page must never stream as a PDF");
  assert.ok(!looksLikePdf(Buffer.from("%PD")), "a truncated signature is not a PDF");
  assert.ok(!looksLikePdf(Buffer.from("  %PDF-")), "the signature must be at the start");
});

test("the renderer rejects output that is empty, tiny or absurd", () => {
  const src = read("src/lib/reports/pdf.ts");
  assert.ok(/MIN_PDF_BYTES/.test(src) && /MAX_PDF_BYTES/.test(src), "both bounds exist");
  assert.ok(/looksLikePdf\(bytes\)/.test(src), "and the signature is checked");
});

test("filenames are readable and safe", () => {
  assert.equal(reportFilename("BMW of Fort Walton Beach", new Date(Date.UTC(2026, 9, 1))), "BMW-of-Fort-Walton-Beach-SEO-Report-2026-10.pdf");
  assert.equal(reportFilename("Findlay Subaru of Las Vegas", new Date(Date.UTC(2026, 0, 9))), "Findlay-Subaru-of-Las-Vegas-SEO-Report-2026-01.pdf");
});

test("a dealership name cannot escape the filename", () => {
  // The name reaches a Content-Disposition header, so a quote or a slash would
  // be a header-injection or path problem rather than a cosmetic one.
  for (const hostile of ["../../etc/passwd", "..\\..\\windows", 'Bob" ; rm -rf /', "a/b/c", "x\r\nSet-Cookie: y", "\u0000null"]) {
    const f = reportFilename(hostile, new Date());
    assert.ok(!/[/\\"'\r\n\u0000]/.test(f), `${hostile} -> ${f} must contain no path or header characters`);
    assert.ok(!f.includes(".."), `${hostile} -> ${f} must not traverse`);
    assert.ok(f.endsWith(".pdf"));
  }
});

test("an unnameable dealership still produces a file", () => {
  assert.ok(reportFilename("", new Date()).startsWith("Dealership-SEO-Report-"));
  assert.ok(reportFilename("…", new Date()).startsWith("Dealership-SEO-Report-"));
});

test("accents and non-Latin names survive readably", () => {
  assert.ok(/Citro/.test(reportFilename("Citroën Göteborg", new Date())));
});

test("the worker can only open the application's own report", () => {
  const src = read("src/lib/reports/pdf.ts");
  // The URL is built from APP_URL plus an id the application authorised. A
  // caller-supplied address would make this an open fetching service.
  assert.ok(/env\(\)\.APP_URL/.test(src), "origin comes from configuration");
  assert.ok(/\/report\/\$\{encodeURIComponent\(String\(dealershipId\)\)\}/.test(src), "path is fixed and the id is encoded");
  assert.ok(!/function reportUrlFor\([^)]*url/.test(src), "no URL parameter is accepted");
  const body = src.slice(src.indexOf("export async function renderReportPdf"));
  assert.ok(/page\.goto\(url/.test(body) && !/page\.goto\([^u]/.test(body), "the only navigation is that URL");
});

test("the render key is scoped, hashed and short-lived", () => {
  const src = read("src/lib/reports/render-token.ts");
  assert.ok(/eq\(reportRenders\.dealershipId, dealershipId\)/.test(src), "scoped to one dealership");
  assert.ok(/eq\(reportRenders\.status, "pending"\)/.test(src), "single-purpose: dead once the render settles");
  assert.ok(/gt\(reportRenders\.expiresAt, new Date\(\)\)/.test(src), "expires");
  assert.ok(/createHash\("sha256"\)/.test(src) && !/return token/.test(src.slice(src.indexOf("dealershipForRenderToken"))), "only the hash is stored");
  assert.ok(/RENDER_TOKEN_TTL_MS = 10 \* 60_000/.test(src), "ten minutes");
});

test("the key is not a session and opens nothing else", () => {
  const page = read("src/app/report/[id]/page.tsx");
  // It is consulted for this one page, and only to skip the tenant guard for
  // the dealership it names.
  assert.ok(/dealershipForRenderToken\(rt, dealershipId\)\) === dealershipId/.test(page));
  assert.ok(/if \(!renderedByWorker\) await requireDealershipAccess\(dealershipId\)/.test(page), "a person still goes through the normal guard");
  const proxy = read("src/proxy.ts");
  assert.ok(/pathname\.startsWith\("\/report\/"\)/.test(proxy), "the edge exemption is limited to report URLs");
});

test("the download route trusts neither id", () => {
  const route = read("src/app/report/[id]/download/[renderId]/route.ts");
  assert.ok(/assertDealershipAccess\(dealershipId\)/.test(route), "dealership checked against the session");
  assert.ok(/takeRenderedPdf\(render, dealershipId\)/.test(route), "the render must belong to that dealership");
  assert.ok(/status: 404/.test(route), "and a mismatch is a 404, not a 403");
});

test("bytes are handed over once and then dropped", () => {
  const src = read("src/lib/reports/request-pdf.ts");
  const fn = src.slice(src.indexOf("export async function takeRenderedPdf"));
  assert.ok(/db\.delete\(reportRenders\)/.test(fn), "the transport row is deleted on delivery");
  assert.ok(/eq\(reportRenders\.status, "ready"\)/.test(fn), "an unfinished render never streams");
  assert.ok(/pruneReportRenders/.test(read("src/lib/jobs/maintenance.ts")), "and abandoned rows are swept");
});

test("a repeated request joins the render already running", () => {
  const src = read("src/lib/reports/request-pdf.ts");
  assert.ok(/eq\(reportRenders\.status, "pending"\)/.test(src) && /if \(inFlight\) return describe\(inFlight\)/.test(src), "a double-click must not start two browsers");
});

test("failures are categorised for the reader, not described", () => {
  const src = read("src/lib/reports/request-pdf.ts");
  assert.ok(/"unavailable" \| "timeout" \| "failed"/.test(src));
  const ui = read("src/components/client/download-report.tsx");
  assert.ok(/temporarily unavailable/.test(ui) && /took too long/.test(ui));
  // Nothing technical reaches the dealership.
  assert.ok(!/Chromium|playwright|stack|ECONN|\/tmp|localhost/i.test(ui.replace(/\/\*[\s\S]*?\*\//g, "")), "no implementation detail in client copy");
});

test("only a runner with a browser claims the render job", () => {
  const runner = read("src/lib/jobs/runner.ts");
  assert.ok(/BROWSER_TYPES: JobType\[\] = \["seo_scan", "report_pdf"\]/.test(runner));
  assert.ok(/ALL_TYPES\.filter\(\(t\) => !BROWSER_TYPES\.includes\(t\)\)/.test(runner), "a browserless tick leaves it queued");
});

test("every job type can actually be claimed", () => {
  // password_reset was enqueued but missing from ALL_TYPES, so its retry job
  // could never be picked up. This guards the whole list against that.
  const schema = read("src/lib/db/schema.ts");
  const enumLine = schema.slice(schema.indexOf('jobTypeEnum = pgEnum("job_type"'));
  const declared = [...enumLine.slice(0, enumLine.indexOf("]")).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).filter((t) => t !== "job_type");
  const runner = read("src/lib/jobs/runner.ts");
  const allTypes = runner.slice(runner.indexOf("const ALL_TYPES"), runner.indexOf("];", runner.indexOf("const ALL_TYPES")));
  for (const t of declared) {
    assert.ok(allTypes.includes(`"${t}"`), `job type ${t} is enqueued but never claimed`);
  }
});

test("the documented worker config cannot silently omit a browser-only job type", () => {
  // Documentation alone drifts. Both seo_scan and report_pdf need Chromium, so
  // a Vercel tick never claims either; a worker rebuilt from this repository
  // with a narrower list would leave one of them queued forever, with no error
  // to notice. This keeps the example and the README honest about that.
  const runner = read("src/lib/jobs/runner.ts");
  const browserTypes = [...runner.slice(runner.indexOf("const BROWSER_TYPES")).slice(0, 160).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(browserTypes, ["seo_scan", "report_pdf"], "this test must be updated if the browser-only set changes");

  const documented = `WORKER_JOB_TYPES=${browserTypes.join(",")}`;
  assert.ok(read(".env.example").includes(documented), `.env.example must show ${documented}`);
  const readme = read("README.md");
  for (const stale of readme.match(/WORKER_JOB_TYPES=[a-z_,]+/g) ?? []) {
    assert.equal(stale, documented, `README still documents ${stale}; a worker built from it would strand ${browserTypes.filter((t) => !stale.includes(t)).join(", ")}`);
  }
});
