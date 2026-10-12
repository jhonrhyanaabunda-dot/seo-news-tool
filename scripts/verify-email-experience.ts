/**
 * Live check of the digest against real data, through the console sink.
 *
 * Nothing is delivered: EMAIL_PROVIDER=console writes the message to stdout.
 * Run against a development database; it creates and removes its own rows.
 */
import "./load-env";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { and, eq, like } from "drizzle-orm";
import { dealerships, emailReports, jobs, seoScans } from "../src/lib/db/schema";

let pass = 0; const fail: string[] = [];
function ck(n: string, ok: boolean, d = "") { if (ok) { pass++; console.log(`  PASS  ${n}`); } else { fail.push(n); console.log(`  FAIL  ${n} — ${d}`); } }

async function main() {
  if (process.env.EMAIL_PROVIDER !== "console") throw new Error("refusing to run: EMAIL_PROVIDER must be 'console' so nothing is delivered");
  const raw = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(raw);
  const { buildDealerDigest } = await import("../src/lib/email/reports");
  const { renderDigestEmail } = await import("../src/lib/email/templates");
  const { getOpportunities } = await import("../src/lib/queries/client-opportunities");
  const { getSettings } = await import("../src/lib/settings");

  const ds = await db.select().from(dealerships).orderBy(dealerships.id);
  const s = await getSettings();
  const since = new Date(Date.now() - 7 * 86_400_000);

  console.log("\nDigest built from real data");
  const a = await buildDealerDigest(ds[0], since, s);
  ck("names the dealership", a.name === ds[0].name);
  const [latest] = await db.select().from(seoScans).where(and(eq(seoScans.dealershipId, ds[0].id), eq(seoScans.status, "completed"))).orderBy(seoScans.completedAt).limit(1);
  void latest;

  console.log("\nEmail ordering matches the product");
  const [newest] = await db
    .select({ id: seoScans.id })
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, ds[0].id), eq(seoScans.status, "completed")))
    .orderBy(seoScans.completedAt)
    .limit(1);
  void newest;
  const opps = a.openOpportunities;
  ck("opportunity count is carried", typeof opps === "number");
  if (a.topIssues.length) {
    const scanRows = await db.select({ id: seoScans.id, completedAt: seoScans.completedAt }).from(seoScans).where(and(eq(seoScans.dealershipId, ds[0].id), eq(seoScans.status, "completed")));
    const latestId = scanRows.sort((x, y) => (y.completedAt?.getTime() ?? 0) - (x.completedAt?.getTime() ?? 0))[0].id;
    const ordered = await getOpportunities(latestId);
    ck("the email's first finding is the product's first finding", a.topIssues[0].label === ordered[0]?.title, `email=${a.topIssues[0].label} product=${ordered[0]?.title}`);
    ck("priority is carried, not severity", ["CRITICAL", "HIGH", "MEDIUM", "LOW"].includes(a.topIssues[0].priority));
    ck("scope reads in words", /page|website|finding/.test(a.topIssues[0].scope), a.topIssues[0].scope);
  }

  console.log("\nTenant isolation inside one send");
  const b = await buildDealerDigest(ds[1], since, s);
  ck("each card carries only its own dealership", !JSON.stringify(a).includes(ds[1].name) && !JSON.stringify(b).includes(ds[0].name));
  ck("each card links to its own report", a.reportUrl.endsWith(`/${ds[0].id}`) && b.reportUrl.endsWith(`/${ds[1].id}`));

  console.log("\nRendered message");
  const r = renderDigestEmail({ kind: "weekly", periodLabel: "Week of test", dashboardUrl: "https://app.example", dealers: [a, b], seoStories: [], timeZone: "America/Chicago" });
  ck("renders both dealerships", r.html.includes(ds[0].name) && r.html.includes(ds[1].name));
  ck("is mobile-capable", /name="viewport"/.test(r.html) && /max-width:640px/.test(r.html));
  ck("carries no render key", !/\?rt=/.test(r.html) && !/\?rt=/.test(r.text));
  ck("no invented delta when none exists", a.scoreDelta !== null || !new RegExp(`${a.name}[\\s\\S]{0,400}\\([+-]\\d`).test(r.html));
  // Length is not the measure: a week with no changes is legitimately short.
  // What matters is that the alternative names both dealerships and leads
  // somewhere useful.
  ck("plain-text alternative is complete", r.text.includes(ds[0].name) && r.text.includes(ds[1].name) && r.text.includes("https://app.example"));
  ck("an unchanged week summarises rather than padding", a.hasChanges || /No meaningful changes/.test(r.text));

  console.log("\nDelivery status vocabulary");
  const { getRecentEmails, getEmailOutcomeCounts } = await import("../src/lib/queries/system");
  const recent = await getRecentEmails(10);
  const counts = await getEmailOutcomeCounts();
  ck("every row carries an outcome", recent.every((e) => ["accepted", "failed", "retrying", "skipped", "queued"].includes(e.outcome)));
  ck("no row claims delivery", !recent.some((e) => String(e.outcome) === "delivered"));
  ck("counts are produced", typeof counts.accepted === "number" && typeof counts.failed === "number");
  console.log(`  ..    outcomes: ${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ")}`);

  await db.delete(emailReports).where(like(emailReports.dedupeKey, "verify-4d:%"));
  await db.delete(jobs).where(like(jobs.dedupeKey, "verify-4d:%"));
  await raw.end();
  console.log(`\n${pass} passed, ${fail.length} failed`);
  process.exit(fail.length ? 1 : 0);
}
main();
