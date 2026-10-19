// Every main screen, as staff and as a dealership client, against the seeded test
// database (e2e/db-server.mjs). Run everything with: npm run test:e2e
import path from "node:path";
import { mkdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(pathToFileURL(path.join(repo, "node_modules/playwright-core/index.mjs")).href);
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3171";
const SHOTS = path.join(repo, "e2e", "shots");
mkdirSync(SHOTS, { recursive: true });

let pass = 0;
const fail: string[] = [];
const ck = (name: string, ok: boolean, detail = "") => {
  if (ok) {
    pass++;
    console.log("  PASS", name);
  } else {
    fail.push(name);
    console.log("  FAIL", name, detail);
  }
};

const browser = await chromium.launch({ headless: true, channel: process.env.E2E_CHROME_CHANNEL ?? "chrome" });

async function signedIn(email: string, password: string) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const problems: string[] = [];
  page.on("console", (m: { type(): string; text(): string }) => {
    const t = m.text();
    // A Content-Security-Policy violation, report-only or enforced, means the policy would break the page.
    if (/Content Security Policy/i.test(t)) problems.push(`CSP: ${t.slice(0, 160)}`);
    else if (m.type() === "error" && !/Download the React DevTools|favicon|\[Fast Refresh\]|hydrat/i.test(t)) problems.push(`console: ${t.slice(0, 160)}`);
  });
  page.on("pageerror", (e: Error) => problems.push(`page error: ${e.message.slice(0, 160)}`));
  await page.goto(`${BASE}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await Promise.all([page.waitForURL((u: URL) => !u.pathname.startsWith("/login"), { timeout: 120000 }), page.click("button[type=submit]")]);
  return { ctx, page, problems };
}

const STAFF_PAGES: Array<[name: string, path: string, expect: string]> = [
  ["dashboard", "/", "Example Motors"],
  ["dealer overview", "/dealerships/1", "Example Motors"],
  ["dealer opportunities", "/dealerships/1?tab=opportunities", "H1"],
  ["dealer issues", "/dealerships/1?tab=issues", "no H1 heading"],
  ["dealer pages", "/dealerships/1?tab=pages", "/service/"],
  ["dealer protected", "/dealerships/1?tab=protected", "Example Motors"],
  ["dealer news", "/dealerships/1?tab=news", "community car show"],
  ["dealer reports", "/dealerships/1?tab=reports", "Example Motors"],
  ["dealer history", "/dealerships/1?tab=history", "SEO score history"],
  ["client view", "/dealerships/1?view=client", "SEO health score"],
  ["news", "/news", "community car show"],
  ["news review", "/news/review", "Review news"],
  ["seo news", "/seo-news", "SEO news"],
  ["admin dealerships", "/admin/dealerships", "Example Motors"],
  ["admin edit dealership", "/admin/dealerships/1/edit", "Example Motors"],
  ["admin settings", "/admin/settings", "Monthly SEO report"],
  ["admin users", "/admin/users", "e2e-client@example.invalid"],
  ["admin system", "/admin/system", "System"],
  ["account", "/account", "Two-factor login"],
  ["printed report", "/report/1", "Example Motors"],
];

console.log("1. Staff (administrator): every screen loads, shows its data, and breaks no policy");
{
  const { ctx, page, problems } = await signedIn("e2e-admin@example.invalid", "E2E-test-password-123");
  for (const [name, p, expect] of STAFF_PAGES) {
    problems.length = 0;
    const res = await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 120000 });
    const status = res?.status() ?? 0;
    const found = await page.getByText(expect, { exact: false }).first().waitFor({ timeout: 20000 }).then(() => true, () => false);
    ck(`${name}: loads (${status}) and shows "${expect}"`, status === 200 && found, `status ${status}, found ${found}`);
    ck(`${name}: no console errors or policy violations`, problems.length === 0, problems.join(" | "));
  }
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  ck("dashboard shows the portfolio trend", await page.getByText("Portfolio score").first().isVisible());
  // Seed: 78 a month ago, 84 now.
  const movers = await page.locator("section", { hasText: "Biggest changes" }).innerText();
  ck("biggest changes shows Example Motors +6 (78 → 84)", movers.includes("Example Motors") && movers.includes("+6") && movers.includes("78 → 84"), movers.slice(0, 200));
  await page.goto(`${BASE}/?trend=30`, { waitUntil: "networkidle" });
  ck("the 30-day switch keeps the dashboard working", await page.getByText("over 30 days").first().isVisible().catch(() => false) || await page.getByText("Not enough history yet").first().isVisible().catch(() => false));
  // Review queue, both scopes: the car show (relevance 75) comes before the Outback trim (30).
  problems.length = 0;
  await page.goto(`${BASE}/news/review?scope=all`, { waitUntil: "networkidle" });
  const queueTitle = () => page.locator("#queue-title").innerText().catch(() => "");
  const left = () => page.getByText("left to review").first().innerText().catch(() => "");
  ck("review queue starts with the most relevant article", (await queueTitle()).includes("community car show") && (await left()).startsWith("2"), `${await queueTitle()} | ${await left()}`);
  await page.keyboard.press("r");
  await page.getByText("Outback").first().waitFor({ timeout: 10000 }).catch(() => {});
  ck("R marks it relevant and moves on", (await queueTitle()).includes("Outback") && (await left()).startsWith("1"), `${await queueTitle()} | ${await left()}`);
  await page.keyboard.press("u");
  await page.locator("#queue-title", { hasText: "community car show" }).waitFor({ timeout: 10000 }).catch(() => {});
  ck("U undoes it", (await queueTitle()).includes("community car show") && (await left()).startsWith("2"), `${await queueTitle()} | ${await left()}`);
  await page.keyboard.press("n");
  await page.locator("#queue-title", { hasText: "Outback" }).waitFor({ timeout: 10000 }).catch(() => {});
  await page.reload({ waitUntil: "networkidle" });
  ck("decisions are saved: after a reload only the Outback article is left", (await queueTitle()).includes("Outback") && (await left()).startsWith("1"), `${await queueTitle()} | ${await left()}`);
  await page.keyboard.press("Enter");
  await page.getByText("All caught up").first().waitFor({ timeout: 10000 }).catch(() => {});
  ck("Enter marks the last one reviewed: all caught up", await page.getByText("All caught up").first().isVisible().catch(() => false));
  ck("review queue: no console errors or policy violations", problems.length === 0, problems.join(" | "));
  await page.goto(`${BASE}/news?status=not_relevant`, { waitUntil: "networkidle" });
  ck("the queue's decision shows in the news list", await page.getByText("community car show").first().isVisible().catch(() => false));

  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(SHOTS, "dashboard.png"), fullPage: true });
  await page.goto(`${BASE}/dealerships/1`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(SHOTS, "dealer-overview.png"), fullPage: true });

  console.log("2. Phone width: no sideways scrolling");
  await page.setViewportSize({ width: 390, height: 844 });
  for (const p of ["/", "/dealerships/1", "/dealerships/1?view=client", "/news", "/news/review", "/admin/settings", "/account"]) {
    await page.goto(`${BASE}${p}`, { waitUntil: "networkidle" });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    ck(`${p} fits a 390px phone`, overflow <= 0, `${overflow}px wider`);
  }
  await ctx.close();
}

console.log("3. Dealership client: sees their dealership, nothing else");
{
  const { ctx, page } = await signedIn("e2e-client@example.invalid", "E2E-client-password-123");
  ck("client lands on their dealership's dashboard", await page.getByText("SEO health score").first().waitFor({ timeout: 30000 }).then(() => true, () => false));
  await page.screenshot({ path: path.join(SHOTS, "client-dashboard.png"), fullPage: true });
  const admin = await page.goto(`${BASE}/admin/settings`);
  ck("client cannot open admin settings", new URL(page.url()).pathname !== "/admin/settings" || (admin?.status() ?? 200) >= 400, page.url());
  const other = await page.goto(`${BASE}/dealerships/999`);
  ck("another dealership is not found", other?.status() === 404, String(other?.status()));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail.length} failed${fail.length ? ": " + fail.join("; ") : ""}`);
process.exit(fail.length ? 1 : 0);
