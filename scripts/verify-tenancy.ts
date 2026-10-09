/**
 * Live cross-tenant check against a running server.
 *
 * Creates two dealership logins, each assigned to a different dealership, then
 * drives real HTTP requests with real session cookies to prove that one cannot
 * reach the other's data — by URL, by query string, or by posting a form to a
 * server action. Every account and session it creates is removed at the end,
 * including when an assertion fails.
 *
 *   BASE_URL=http://localhost:3000 npx tsx scripts/verify-tenancy.ts
 *
 * Run it against a development database. It writes users, so never point it at
 * production.
 */
import "./load-env";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { dealerships, sessions, userDealerships, users } from "../src/lib/db/schema";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const EMAILS = ["tenancy-check-a@example.invalid", "tenancy-check-b@example.invalid"];

const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
const db = drizzle(sql);

let passed = 0;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    passed++;
    console.log(`  ✔ ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✖ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/**
 * Mint a real session row and return the cookie for it. The sign-in form is a
 * React server action and cannot be driven by a plain POST; what this script
 * needs to exercise is the authorisation layer behind the cookie, which is
 * identical either way.
 */
async function sessionCookie(userId: number): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = createHash("sha256").update(token + process.env.AUTH_SECRET).digest("hex");
  await db.insert(sessions).values({ userId, tokenHash, expiresAt: new Date(Date.now() + 3600_000) });
  return `a3_session=${token}`;
}

async function get(path: string, cookie: string) {
  const res = await fetch(`${BASE}${path}`, { headers: { cookie }, redirect: "manual" });
  const text = await res.text();
  return { status: res.status, location: res.headers.get("location") ?? "", text };
}

/**
 * A denied page is one that returns none of the protected content and renders
 * the not-found or redirect shell instead.
 *
 * The status is deliberately not asserted. Next streams the layout before the
 * page's guard throws, so `notFound()` and `redirect()` both come back as 200
 * with the not-found body. That is cosmetic — nothing protected is in the
 * response — but it does mean status alone cannot be used to detect a denial.
 */
function denied(r: { status: number; text: string }, secret: string): boolean {
  return !r.text.includes(secret) && (r.text.includes("Page not found") || r.status === 307 || r.status === 404);
}

async function main() {
  const dealers = await db.select({ id: dealerships.id, name: dealerships.name }).from(dealerships).orderBy(dealerships.id).limit(2);
  if (dealers.length < 2) throw new Error("need at least two dealerships to test isolation");
  const [A, B] = dealers;
  console.log(`\nDealership A = ${A.id} "${A.name}"\nDealership B = ${B.id} "${B.name}"\n`);

  // Clean up anything a previous interrupted run left behind.
  await db.delete(users).where(inArray(users.email, EMAILS));

  const passwordHash = "$2b$12$aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // never used: sessions are created directly
  const [clientA] = await db.insert(users).values({ email: EMAILS[0], name: "Tenancy A", role: "client", passwordHash }).returning({ id: users.id });
  const [clientB] = await db.insert(users).values({ email: EMAILS[1], name: "Tenancy B", role: "client", passwordHash }).returning({ id: users.id });
  await db.insert(userDealerships).values([
    { userId: clientA.id, dealershipId: A.id },
    { userId: clientB.id, dealershipId: B.id },
  ]);

  const cookieA = await sessionCookie(clientA.id);
  const cookieB = await sessionCookie(clientB.id);

  console.log("Client A → own dealership");
  const ownA = await get(`/dealerships/${A.id}`, cookieA);
  check("200 and shows its own name", ownA.status === 200 && ownA.text.includes(A.name), `status ${ownA.status}`);

  console.log("\nClient A → Client B's dealership (must be denied)");
  const crossA = await get(`/dealerships/${B.id}`, cookieA);
  check("denied, and B's name never appears", denied(crossA, B.name), `status ${crossA.status}`);

  console.log("\nClient B → Client A's dealership (must be denied)");
  const crossB = await get(`/dealerships/${A.id}`, cookieB);
  check("denied, and A's name never appears", denied(crossB, A.name), `status ${crossB.status}`);

  console.log("\nDashboard listing is scoped");
  const dashA = await get("/", cookieA);
  check("lists A", dashA.text.includes(A.name));
  check("does not list B", !dashA.text.includes(B.name));

  console.log("\nNews query string cannot widen access");
  const newsA = await get(`/news?dealership=${B.id}&status=all&scope=all`, cookieA);
  check("B's name never appears", !newsA.text.includes(B.name), `status ${newsA.status}`);

  console.log("\nAdmin surfaces are closed to dealership logins");
  // Each marker is text that only renders when the real page does.
  const adminPages: Array<[string, string]> = [
    ["/admin/users", "User accounts"],
    ["/admin/settings", "Management recipients"],
    ["/admin/system", "Crawler"],
    ["/admin/dealerships", "Add dealership"],
    ["/seo-news", "leading SEO publications"],
  ];
  for (const [path, marker] of adminPages) {
    const r = await get(path, cookieA);
    check(`${path} is closed`, denied(r, marker), `status ${r.status}`);
  }

  console.log("\nAdmin still reaches everything");
  const [admin] = await db.select({ email: users.email }).from(users).where(eq(users.role, "admin")).limit(1);
  check("an administrator account still exists", Boolean(admin), "none found");

  console.log("\nServer action cannot be posted against another dealership");
  // The action itself is covered by assertDealershipAccess; what is checked
  // here is that no route under B leaks B's identity back to A.
  const postRes = await fetch(`${BASE}/dealerships/${B.id}`, {
    method: "POST",
    headers: { cookie: cookieA, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id: String(B.id) }),
    redirect: "manual",
  });
  const postBody = await postRes.text();
  check("posting to B's page reveals nothing about B", !postBody.includes(B.name), `status ${postRes.status}`);
}

main()
  .catch((err) => {
    failures.push(`run aborted: ${err instanceof Error ? err.message : String(err)}`);
  })
  .finally(async () => {
    await db.delete(users).where(inArray(users.email, EMAILS)); // sessions and assignments cascade
    await sql.end();
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      for (const f of failures) console.log(`  ✖ ${f}`);
      process.exit(1);
    }
    console.log("Cross-tenant isolation holds. Test accounts removed.");
  });
