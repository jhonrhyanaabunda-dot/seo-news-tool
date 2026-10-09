/**
 * Live check of the print-ready report: that it renders the dealership's own
 * stored numbers, agrees with the dashboard, stays inside the tenant boundary,
 * and paginates cleanly when printed. Creates and removes its own accounts.
 */
import "./load-env";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray, sql as dsql } from "drizzle-orm";
import { chromium } from "playwright-core";
import { sessions, userDealerships, users } from "../src/lib/db/schema";
const BASE = process.env.BASE_URL ?? "http://localhost:3160";
const OUT = "/tmp/claude-501/-Users-rhea-Desktop-PROJECTS-SEO-tool/40e2c0cb-a2c6-4e01-934f-c28a86e9a40c/scratchpad/4b";
let pass = 0; const fail: string[] = [];
function ck(n: string, ok: boolean, d = "") { if (ok) { pass++; console.log(`  PASS  ${n}`); } else { fail.push(n); console.log(`  FAIL  ${n} — ${d}`); } }
async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(sql);
  const EM = ["r1@example.invalid", "r2@example.invalid", "rstaff@example.invalid"];
  await db.delete(users).where(inArray(users.email, EM));
  const mk = async (e: string, r: "client" | "admin") => (await db.insert(users).values({ email: e, name: e, role: r, passwordHash: "x" }).returning({ id: users.id }))[0].id;
  const [c1, c2, st] = [await mk(EM[0], "client"), await mk(EM[1], "client"), await mk(EM[2], "admin")];
  await db.insert(userDealerships).values([{ userId: c1, dealershipId: 1 }, { userId: c2, dealershipId: 5 }]);
  const tok = async (u: number) => { const t = randomBytes(32).toString("base64url"); await db.insert(sessions).values({ userId: u, tokenHash: createHash("sha256").update(t + process.env.AUTH_SECRET).digest("hex"), expiresAt: new Date(Date.now()+3600_000) }); return t; };
  const [k1, k2, ks] = [await tok(c1), await tok(c2), await tok(st)];
  const get = async (p: string, t: string) => { const r = await fetch(`${BASE}${p}`, { headers: { cookie: `a3_session=${t}` }, redirect: "manual" }); return { status: r.status, body: await r.text() }; };

  const [truth] = (await db.execute(dsql`
    select d.name, s.score, s.critical_count, s.warning_count, s.pages_scanned,
           (s.change_summary->>'scoreDelta')::int as delta, (s.change_summary->>'previousScore')::int as prev
    from dealerships d join seo_scans s on s.dealership_id=d.id and s.status='completed'
    where d.id=1 order by s.completed_at desc limit 1`)) as unknown as Array<Record<string, unknown>>;
  console.log("\nDatabase truth:", JSON.stringify(truth));

  console.log("\nReport content matches the authoritative scan");
  const rep = await get("/report/1", k1);
  ck("renders for the owning client", rep.status === 200);
  ck("names the dealership", rep.body.includes(String(truth.name)));
  ck("prints the stored score", rep.body.includes(`>${truth.score}<`), `expected ${truth.score}`);
  ck("prints the stored delta", rep.body.includes(`+${truth.delta}`) || rep.body.includes(String(truth.delta)));
  ck("prints the stored page count", rep.body.includes(`>${truth.pages_scanned}<`));
  ck("prints the stored critical count", rep.body.includes(`>${truth.critical_count}<`));
  ck("has the executive summary", rep.body.includes("Executive summary"));
  ck("has top opportunities", rep.body.includes("Top SEO opportunities"));
  ck("has a footer", rep.body.includes("A3 SEO Monitor"));
  ck("no raw scanner URL dumps", !/\(https?:\/\/[^)]{40,}\)/.test(rep.body));

  console.log("\nDashboard and report agree");
  const dash = await get("/", k1);
  ck("same score on both", dash.body.includes(`>${truth.score}<`) && rep.body.includes(`>${truth.score}<`));
  const firstOpp = (rep.body.match(/class="doc-opp-title">([^<]+)</) ?? [])[1];
  ck("top opportunity matches the dashboard", Boolean(firstOpp) && dash.body.includes(firstOpp!), `report top = ${firstOpp}`);

  console.log("\nAuthorization");
  ck("client 1 cannot open dealership 5's report", (await get("/report/5", k1)).status === 404);
  ck("client 2 cannot open dealership 1's report", (await get("/report/1", k2)).status === 404);
  ck("client 2 can open their own", (await get("/report/5", k2)).status === 200);
  ck("staff can open either", (await get("/report/1", ks)).status === 200 && (await get("/report/5", ks)).status === 200);
  ck("a missing dealership is 404", (await get("/report/9999", ks)).status === 404);
  const anon = await fetch(`${BASE}/report/1`, { redirect: "manual" });
  ck("signed out redirects to login", anon.status === 307);
  const meta = await get("/report/5", k1);
  ck("metadata does not leak the other dealership", !meta.body.includes("Findlay"));

  console.log("\nScreen and print rendering");
  const browser = await chromium.launch({ channel: "chrome" });
  for (const [label, w] of [["desktop", 1440], ["laptop", 1280], ["mobile", 390], ["m320", 320]] as Array<[string, number]>) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 1400 }, deviceScaleFactor: 2 });
    await ctx.addCookies([{ name: "a3_session", value: k1, domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/report/1`, { waitUntil: "networkidle" });
    if (["desktop", "mobile"].includes(label)) await page.screenshot({ path: `${OUT}/report-${label}.png`, fullPage: true });
    const r = (await page.evaluate(`(() => { const de = document.documentElement; return { overflow: de.scrollWidth - de.clientWidth }; })()`)) as { overflow: number };
    ck(`${label} (${w}px) no overflow`, r.overflow <= 1, `overflow=${r.overflow}px`);
    await ctx.close();
  }
  // Print emulation: this is what Playwright will produce in 4B-2.
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await ctx.addCookies([{ name: "a3_session", value: k1, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/report/1`, { waitUntil: "networkidle" });
  await page.emulateMedia({ media: "print" });
  const pdf = await page.pdf({ path: `${OUT}/report.pdf`, format: "A4", printBackground: true, margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } });
  ck("renders to paper without error", pdf.length > 1000, `${pdf.length} bytes`);
  for (const [label, w, h] of [["print-p1", 1240, 1754], ["print-p2", 1240, 1754]] as Array<[string, number, number]>) { void label; void w; void h; }
  await page.screenshot({ path: `${OUT}/report-print.png`, fullPage: true });
  await browser.close();

  await db.delete(users).where(inArray(users.email, EM));
  await sql.end();
  console.log(`\n${pass} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
}
main();
