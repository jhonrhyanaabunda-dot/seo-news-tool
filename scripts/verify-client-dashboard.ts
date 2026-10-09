/**
 * Live check of the dealership-facing dashboard: that it shows this
 * dealership's own stored numbers, that it stays inside the tenant boundary,
 * and that the staff portfolio view is untouched. Run against a development
 * database with a server on BASE_URL; it creates and removes its own accounts.
 */
import "./load-env";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { inArray, sql as dsql } from "drizzle-orm";
import { sessions, userDealerships, users } from "../src/lib/db/schema";
let pass = 0; const fail: string[] = [];
function ck(n: string, ok: boolean, d = "") {
  if (ok) {
    pass++;
    console.log(`  PASS  ${n}`);
  } else {
    fail.push(n);
    console.log(`  FAIL  ${n} — ${d}`);
  }
}
const BASE = process.env.BASE_URL ?? "http://localhost:3141";

async function main() {
  const sql = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(sql);
  const EM = ["c1@example.invalid", "c2@example.invalid", "staff@example.invalid"];
  await db.delete(users).where(inArray(users.email, EM));
  const mk = async (email: string, role: "client" | "admin") => (await db.insert(users).values({ email, name: email, role, passwordHash: "x" }).returning({ id: users.id }))[0].id;
  const [c1, c2, st] = [await mk(EM[0], "client"), await mk(EM[1], "client"), await mk(EM[2], "admin")];
  await db.insert(userDealerships).values([{ userId: c1, dealershipId: 1 }, { userId: c2, dealershipId: 5 }]);
  const tok = async (uid: number) => { const t = randomBytes(32).toString("base64url"); await db.insert(sessions).values({ userId: uid, tokenHash: createHash("sha256").update(t + process.env.AUTH_SECRET).digest("hex"), expiresAt: new Date(Date.now()+3600_000) }); return `a3_session=${t}`; };
  const [k1, k2, ks] = [await tok(c1), await tok(c2), await tok(st)];
  const get = async (p: string, c: string) => { const r = await fetch(`${BASE}${p}`, { headers: { cookie: c }, redirect: "manual" }); return { status: r.status, body: await r.text() }; };

  // --- authoritative values straight from the database ---
  const [row] = (await db.execute(dsql`
    select d.name, s.score, s.critical_count, s.warning_count, s.pages_scanned,
           (s.change_summary->>'scoreDelta')::int as delta,
           (s.change_summary->>'previousScore')::int as prev
    from dealerships d
    join seo_scans s on s.dealership_id = d.id and s.status='completed'
    where d.id = 1 order by s.completed_at desc limit 1`)) as unknown as Array<Record<string, unknown>>;
  console.log("\nDatabase truth for dealership 1:", JSON.stringify(row));

  console.log("\nClient 1 landing page (/)");
  const home = await get("/", k1);
  ck("renders 200", home.status === 200);
  ck("shows their dealership name", home.body.includes(String(row.name)));
  ck("shows the score from the database", home.body.includes(`>${row.score}<`), `expected ${row.score}`);
  ck("shows the critical count", home.body.includes(`>${row.critical_count}<`));
  ck("shows the warning count", home.body.includes(`>${row.warning_count}<`));
  ck("shows the score explanation", home.body.includes("What does this mean?"));
  ck("shows 'what to do next'", home.body.includes("What to do next"));
  ck("shows pages monitored", home.body.includes("Pages monitored"));
  ck("no fleet language", !home.body.includes("Average SEO score") && !home.body.includes("Coverage"));
  ck("no other dealership", !home.body.includes("Findlay"));
  // 4B gave the dashboard a direct link to the printable report.
  ck("links to the printable SEO report", home.body.includes('href="/report/1"') && home.body.includes("SEO report"));

  console.log("\nTenant isolation");
  ck("client 1 cannot reach dealership 5", (await get("/dealerships/5", k1)).status === 404);
  ck("client 2 cannot reach dealership 1", (await get("/dealerships/1", k2)).status === 404);
  const c2home = await get("/", k2);
  ck("client 2 sees only their own dealership", c2home.body.includes("Findlay") && !c2home.body.includes("BMW of Fort Walton"));
  ck("client cannot open the staff Pages tab", !(await get("/dealerships/1?tab=pages", k1)).body.includes("Not evaluated"));
  ck("client cannot open crawl history", !(await get("/dealerships/1?tab=history", k1)).body.includes("Previous scans"));

  console.log("\nStaff experience preserved");
  const staff = await get("/", ks);
  ck("staff still get the portfolio view", staff.body.includes("Average SEO score") && staff.body.includes("Coverage"));
  ck("staff see both dealerships", staff.body.includes("BMW of Fort Walton") && staff.body.includes("Findlay"));
  const staffDealer = await get("/dealerships/1", ks);
  ck("staff keep their technical overview", staffDealer.status === 200);
  ck("staff get a client-view toggle", staffDealer.body.includes("Client view"));
  ck("the toggle renders the client dashboard", (await get("/dealerships/1?view=client", ks)).body.includes("What does this mean?"));

  await db.delete(users).where(inArray(users.email, EM));
  await sql.end();
  console.log(`\n${pass} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
}
main();
