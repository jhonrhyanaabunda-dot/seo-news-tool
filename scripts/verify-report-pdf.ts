/**
 * End-to-end check of PDF generation: request → job → worker render → download.
 *
 * Runs the render in-process (the same code path the crawler worker takes) so
 * the whole flow can be exercised without the launchd worker. Creates and
 * removes its own accounts and rows.
 */
import "./load-env";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, inArray, sql } from "drizzle-orm";
import { dealerships, jobs, reportRenders, sessions, userDealerships, users } from "../src/lib/db/schema";

const BASE = process.env.BASE_URL ?? "http://localhost:3170";
let pass = 0;
const fail: string[] = [];
function ck(n: string, ok: boolean, d = "") {
  if (ok) { pass++; console.log(`  PASS  ${n}`); } else { fail.push(n); console.log(`  FAIL  ${n} — ${d}`); }
}

async function main() {
  process.env.APP_URL = BASE; // the renderer opens the app under test
  const { db } = await import("../src/lib/db");
  const { requestReportPdf, getRenderStatus } = await import("../src/lib/reports/request-pdf");
  const { runReportPdfJob, reportFilename, looksLikePdf } = await import("../src/lib/reports/pdf");
  const { closeBrowser } = await import("../src/lib/seo/browser-fetch");

  const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  const plain = drizzle(raw);
  const EM = ["pdf1@example.invalid", "pdf2@example.invalid"];
  await plain.delete(users).where(inArray(users.email, EM));
  const ds = await plain.select({ id: dealerships.id, name: dealerships.name }).from(dealerships).orderBy(dealerships.id);
  const mk = async (e: string) => (await plain.insert(users).values({ email: e, name: e, role: "client", passwordHash: "x" }).returning({ id: users.id }))[0].id;
  const [c1, c2] = [await mk(EM[0]), await mk(EM[1])];
  await plain.insert(userDealerships).values([{ userId: c1, dealershipId: ds[0].id }, { userId: c2, dealershipId: ds[1].id }]);
  const tok = async (u: number) => { const t = randomBytes(32).toString("base64url"); await plain.insert(sessions).values({ userId: u, tokenHash: createHash("sha256").update(t + process.env.AUTH_SECRET).digest("hex"), expiresAt: new Date(Date.now() + 3600_000) }); return t; };
  const [k1, k2] = [await tok(c1), await tok(c2)];
  const get = async (p: string, t: string) => fetch(`${BASE}${p}`, { headers: { cookie: `a3_session=${t}` }, redirect: "manual" });

  console.log("\nFilenames are safe and professional");
  ck("normal name", reportFilename("BMW of Fort Walton Beach", new Date(Date.UTC(2026, 9, 1))) === "BMW-of-Fort-Walton-Beach-SEO-Report-2026-10.pdf", reportFilename("BMW of Fort Walton Beach", new Date(Date.UTC(2026, 9, 1))));
  for (const [label, input] of [["path traversal", "../../etc/passwd"], ["slashes", "A/B\\C"], ["quotes", 'Bob"s "Cars"'], ["unicode", "Citroën Göteborg"], ["punctuation", "Smith & Sons, Inc."]] as Array<[string, string]>) {
    const f = reportFilename(input, new Date());
    ck(`${label} sanitised`, !/[/\\".]/.test(f.replace(/\.pdf$/, "")) && !f.includes(".."), f);
  }
  ck("empty name still yields a file", reportFilename("", new Date()).startsWith("Dealership-SEO-Report-"));

  console.log("\nPDF validation rejects non-PDFs");
  ck("accepts a real signature", looksLikePdf(Buffer.from("%PDF-1.7\nrest")));
  ck("rejects empty", !looksLikePdf(Buffer.alloc(0)));
  ck("rejects HTML", !looksLikePdf(Buffer.from("<!doctype html><html>")));
  ck("rejects a short buffer", !looksLikePdf(Buffer.from("%PD")));

  console.log("\nRequest → render → download");
  const req = await requestReportPdf(ds[0].id, c1);
  ck("request is accepted and pending", req.state === "pending", JSON.stringify(req));
  const again = await requestReportPdf(ds[0].id, c1);
  ck("a repeat request joins the one in flight", again.state === "pending" && "id" in req && "id" in again && again.id === req.id, "duplicate render started");
  const queued = await plain.select({ id: jobs.id, payload: jobs.payload }).from(jobs).where(and(eq(jobs.type, "report_pdf"), eq(jobs.status, "queued")));
  ck("exactly one job queued", queued.length === 1, `${queued.length} jobs`);
  ck("the key is in the job payload, not the row", Boolean(queued[0]?.payload?.token));
  const [stored] = await plain.select().from(reportRenders).where(eq(reportRenders.id, (req as { id: number }).id));
  ck("the row stores only a hash", stored.tokenHash.length === 64 && stored.tokenHash !== queued[0].payload.token);

  const t0 = Date.now();
  const result = await runReportPdfJob((req as { id: number }).id, String(queued[0].payload.token));
  const ms = Date.now() - t0;
  ck("render produced bytes", result.bytes > 1000, `${result.bytes} bytes`);
  console.log(`  ..    generation took ${ms}ms, ${(result.bytes / 1024).toFixed(0)} KB`);
  const ready = await getRenderStatus((req as { id: number }).id, ds[0].id);
  ck("status is ready", ready?.state === "ready", JSON.stringify(ready));

  const dl = await get(`/report/${ds[0].id}/download/${(req as { id: number }).id}`, k1);
  const body = Buffer.from(await dl.arrayBuffer());
  ck("download returns 200", dl.status === 200, `status ${dl.status}`);
  ck("content type is pdf", dl.headers.get("content-type") === "application/pdf");
  ck("attachment with a safe filename", /attachment; filename="[^"/\\]+\.pdf"/.test(dl.headers.get("content-disposition") ?? ""), dl.headers.get("content-disposition") ?? "");
  ck("bytes are a real PDF", looksLikePdf(body), `${body.length} bytes`);
  const pages = (body.toString("latin1").match(/\/Count\s+(\d+)/) ?? [])[1];
  console.log(`  ..    delivered ${(body.length / 1024).toFixed(0)} KB, ${pages ?? "?"} pages`);

  console.log("\nBytes are discarded after delivery");
  const after = await plain.select({ id: reportRenders.id }).from(reportRenders).where(eq(reportRenders.id, (req as { id: number }).id));
  ck("transport row removed", after.length === 0);
  ck("second download is 404", (await get(`/report/${ds[0].id}/download/${(req as { id: number }).id}`, k1)).status === 404);

  console.log("\nAuthorization");
  const other = await requestReportPdf(ds[1].id, c2);
  ck("client 1 cannot download client 2's render", (await get(`/report/${ds[1].id}/download/${(other as { id: number }).id}`, k1)).status === 404);
  ck("client 1 cannot pass their own dealership with a foreign render", (await get(`/report/${ds[0].id}/download/${(other as { id: number }).id}`, k1)).status === 404);
  ck("malformed id is 404", (await get(`/report/${ds[0].id}/download/abc`, k1)).status === 404);
  ck("client 2's own pending render is not downloadable yet", (await get(`/report/${ds[1].id}/download/${(other as { id: number }).id}`, k2)).status === 404, "a render still pending must not stream");
  ck("missing render is 404", (await get(`/report/${ds[0].id}/download/999999`, k1)).status === 404);
  const anon = await fetch(`${BASE}/report/${ds[0].id}/download/1`, { redirect: "manual" });
  ck("signed out is refused", anon.status === 401 || anon.status === 307, `status ${anon.status}`);

  console.log("\nThe render key authorises one report and nothing else");
  const [row2] = await plain.select().from(reportRenders).where(eq(reportRenders.id, (other as { id: number }).id));
  // Pick the job belonging to *this* render, not merely the first queued one.
  const [job2] = await plain
    .select({ payload: jobs.payload })
    .from(jobs)
    .where(and(eq(jobs.type, "report_pdf"), sql`(${jobs.payload}->>'renderId')::bigint = ${(other as { id: number }).id}`));
  const key = String(job2.payload.token);
  ck("key opens its own report", (await fetch(`${BASE}/report/${row2.dealershipId}?rt=${key}`, { redirect: "manual" })).status === 200);
  ck("key does not open another dealership", (await fetch(`${BASE}/report/${ds[0].id}?rt=${key}`, { redirect: "manual" })).status === 307);
  ck("key does not open the dashboard", (await fetch(`${BASE}/?rt=${key}`, { redirect: "manual" })).status === 307);
  ck("a forged key is refused", (await fetch(`${BASE}/report/${row2.dealershipId}?rt=${randomBytes(32).toString("base64url")}`, { redirect: "manual" })).status === 307);

  await closeBrowser();
  await plain.delete(reportRenders).where(inArray(reportRenders.dealershipId, ds.map((d) => d.id)));
  await plain.delete(jobs).where(eq(jobs.type, "report_pdf"));
  await plain.delete(users).where(inArray(users.email, EM));
  await raw.end();
  void db;
  console.log(`\n${pass} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
}
main();
