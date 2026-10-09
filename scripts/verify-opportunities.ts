/**
 * Live check of the opportunities experience: that it renders from the latest
 * scan, agrees with the dashboard summary, stays inside the tenant boundary,
 * preserves staff access, and reflows without overflow. Run against a
 * development database with a server on BASE_URL; creates and removes its own
 * accounts.
 */
import "./load-env";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray } from "drizzle-orm";
import { chromium } from "playwright-core";
import { sessions, userDealerships, users } from "../src/lib/db/schema";
const BASE = process.env.BASE_URL ?? "http://localhost:3151";
const OUT = "/tmp/claude-501/-Users-rhea-Desktop-PROJECTS-SEO-tool/40e2c0cb-a2c6-4e01-934f-c28a86e9a40c/scratchpad/4c";
let pass = 0; const fail: string[] = [];
function ck(n: string, ok: boolean, d = "") { if (ok) { pass++; console.log(`  PASS  ${n}`); } else { fail.push(n); console.log(`  FAIL  ${n} — ${d}`); } }
const PROBE = `(() => { const de = document.documentElement; const wide = [];
  for (const el of Array.from(document.querySelectorAll("body *"))) { const b = el.getBoundingClientRect(); if (!b.width) continue;
    if (b.right > de.clientWidth + 1) { let sc = false; for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === "auto" || o === "scroll") { sc = true; break; } } if (!sc) wide.push(el.tagName.toLowerCase()); } }
  return { overflow: de.scrollWidth - de.clientWidth, wide: Array.from(new Set(wide)).slice(0,3) }; })()`;
async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(sql);
  const EM = ["o1@example.invalid", "o2@example.invalid", "ostaff@example.invalid"];
  await db.delete(users).where(inArray(users.email, EM));
  const mk = async (e: string, r: "client" | "admin") => (await db.insert(users).values({ email: e, name: e, role: r, passwordHash: "x" }).returning({ id: users.id }))[0].id;
  const [c1, c2, st] = [await mk(EM[0], "client"), await mk(EM[1], "client"), await mk(EM[2], "admin")];
  await db.insert(userDealerships).values([{ userId: c1, dealershipId: 1 }, { userId: c2, dealershipId: 5 }]);
  const tok = async (u: number) => { const t = randomBytes(32).toString("base64url"); await db.insert(sessions).values({ userId: u, tokenHash: createHash("sha256").update(t + process.env.AUTH_SECRET).digest("hex"), expiresAt: new Date(Date.now()+3600_000) }); return `a3_session=${t}`; };
  const [k1, k2, ks] = [await tok(c1), await tok(c2), await tok(st)];
  const get = async (p: string, c: string) => { const r = await fetch(`${BASE}${p}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, body: await r.text() }; };

  console.log("\nOpportunities page");
  const o = await get("/dealerships/1?tab=opportunities", k1);
  ck("renders for the owning client", o.status === 200);
  ck("has the client-facing heading", o.body.includes("SEO opportunities"));
  ck("explains the basis", o.body.includes("Recommended actions based on your latest website check"));
  ck("shows priority labels as words", o.body.includes("priority"));
  ck("shows a recommended action", o.body.includes("Recommended action"));
  ck("shows scope", /pages affected|Affects the whole website|findings/.test(o.body));

  console.log("\nDashboard and opportunities agree");
  const dash = await get("/", k1);
  const firstOnPage = (o.body.match(/<h3 class="mt-2 break-words[^"]*">([^<]+)</) ?? [])[1];
  ck("dashboard links to opportunities", dash.body.includes("tab=opportunities"));
  ck("top opportunity appears on both", Boolean(firstOnPage) && dash.body.includes(firstOnPage!), `page top = ${firstOnPage}`);

  console.log("\nTenant isolation");
  ck("client 1 cannot open dealership 5 opportunities", (await get("/dealerships/5?tab=opportunities", k1)).status === 404);
  ck("client 2 cannot open dealership 1 opportunities", (await get("/dealerships/1?tab=opportunities", k2)).status === 404);
  const c2o = await get("/dealerships/5?tab=opportunities", k2);
  ck("client 2 sees only their own", c2o.status === 200 && !c2o.body.includes("BMW of Fort Walton"));

  console.log("\nStaff access preserved");
  ck("staff can open opportunities", (await get("/dealerships/1?tab=opportunities", ks)).status === 200);
  ck("staff keep their own tabs", (await get("/dealerships/1?tab=history", ks)).body.includes("Previous scans"));
  ck("client still blocked from staff tabs", !(await get("/dealerships/1?tab=history", k1)).body.includes("Previous scans"));

  console.log("\nResponsive");
  const browser = await chromium.launch({ channel: "chrome" });
  for (const [label, w] of [["desktop", 1440], ["laptop", 1280], ["tablet", 768], ["mobile", 390], ["m360", 360], ["m320", 320]] as Array<[string, number]>) {
    const ctx = await browser.newContext({ viewport: { width: w, height: 1400 }, deviceScaleFactor: 2 });
    await ctx.addCookies([{ name: "a3_session", value: k1.split("=")[1], domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    await page.goto(`${BASE}/dealerships/1?tab=opportunities`, { waitUntil: "networkidle" });
    if (["desktop", "mobile"].includes(label)) await page.screenshot({ path: `${OUT}/opp-${label}.png`, fullPage: true });
    const r = (await page.evaluate(PROBE)) as { overflow: number; wide: string[] };
    ck(`${label} (${w}px) no overflow`, r.overflow <= 1 && !r.wide.length, `overflow=${r.overflow} ${r.wide.join(" ")}`);
    await ctx.close();
  }
  await browser.close();
  await db.delete(users).where(inArray(users.email, EM));
  await sql.end();
  console.log(`\n${pass} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
}
main();
