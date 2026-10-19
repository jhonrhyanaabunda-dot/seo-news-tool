// End-to-end test of two-factor login in a real browser, against the throwaway database
// (e2e/db-server.mjs). Run everything with: npm run test:e2e
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { chromium } = await import(pathToFileURL(path.join(repo, "node_modules/playwright-core/index.mjs")).href);
const { totpCode, totpStep } = await import(pathToFileURL(path.join(repo, "src/lib/auth/totp.ts")).href);
const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3171";
const SHOTS = path.join(repo, "e2e", "shots");
(await import("node:fs")).mkdirSync(SHOTS, { recursive: true });
const EMAIL = "e2e-admin@example.invalid", PASSWORD = "E2E-test-password-123";
let pass = 0; const fail: string[] = [];
const ck = (name: string, ok: boolean, detail = "") => { if (ok) { pass++; console.log("  PASS", name); } else { fail.push(name); console.log("  FAIL", name, detail); } };
const waitNextStep = async () => { const s = totpStep(); while (totpStep() === s) await new Promise((r) => setTimeout(r, 500)); };

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const signIn = async () => {
  await page.goto(`${BASE}/login`);
  await page.fill("#email", EMAIL); await page.fill("#password", PASSWORD);
  await Promise.all([page.waitForURL((u: URL) => !u.pathname.startsWith("/login") || u.pathname === "/login/verify", { timeout: 120000 }), page.click("button[type=submit]")]);
};
const signOut = async () => { await page.click("button[aria-label='Sign out'] >> visible=true"); await page.waitForURL(/\/login/); };
const body = () => page.locator("body").innerText();
const seen = async (text: string, timeout = 30000) => page.getByText(text, { exact: false }).first().waitFor({ timeout }).then(() => true, () => false);

console.log("1. Without 2FA");
await signIn();
ck("password alone signs in", new URL(page.url()).pathname === "/", page.url());
ck("admins are prompted to set it up", await seen("Protect this administrator account with two-factor login"));

console.log("2. Set up");
await page.goto(`${BASE}/account`);
await page.click("text=Set up two-factor login");
await page.waitForSelector("img[alt='QR code for your authenticator app']");
const key = (await page.locator("code.select-all").first().innerText()).replace(/\s/g, "");
ck("QR code and key are shown", key.length >= 32, key);
await page.screenshot({ path: `${SHOTS}/account-setup.png`, fullPage: true });
await page.fill("#setup-code", "000000"); await page.click("text=Turn on two-factor login");
ck("a wrong first code is refused", await seen("That code is not right"));
await page.fill("#setup-code", totpCode(key, totpStep())); await page.click("text=Turn on two-factor login");
await page.waitForSelector("text=Save these recovery codes");
const codes = await page.locator("ul li.select-all").allInnerTexts();
ck("10 recovery codes are shown once", codes.length === 10, String(codes.length));
await page.screenshot({ path: `${SHOTS}/account-recovery-codes.png`, fullPage: true });
await page.goto(`${BASE}/account`);
ck("status shows On with 10 codes unused", await seen("10 of 10 recovery codes unused"));
ck("recovery codes are not shown again", !(await body()).includes(codes[0]));

console.log("3. Sign-in now needs a code");
await signOut();
await signIn();
ck("password alone stops at the code step", new URL(page.url()).pathname === "/login/verify", page.url());
await page.screenshot({ path: `${SHOTS}/verify.png`, fullPage: true });
await page.goto(`${BASE}/`);
ck("no access before the code", new URL(page.url()).pathname === "/login", page.url());
await page.goto(`${BASE}/login/verify`);
await page.fill("#code", "123456"); await page.click("button[type=submit]");
ck("a wrong code is refused", await seen("That code is not right"));
const before = totpStep();
await page.fill("#code", totpCode(key, totpStep())); await page.click("button[type=submit]");
const replayRefused = await seen("That code is not right", 15000);
const sameWindow = totpStep() === before;
if (sameWindow) ck("the code already used at setup cannot be replayed", replayRefused);
if (new URL(page.url()).pathname !== "/") {
  await waitNextStep();
  await page.fill("#code", totpCode(key, totpStep())); await page.click("button[type=submit]");
  await page.waitForURL((u: URL) => u.pathname === "/", { timeout: 60000 }).catch(() => {});
}
ck("a fresh code signs in", new URL(page.url()).pathname === "/", page.url());
await page.getByRole("heading", { name: "Dashboard" }).waitFor();
ck("the prompt is gone once 2FA is on", !(await body()).includes("Protect this administrator account"));

console.log("4. Recovery code");
await signOut(); await signIn();
await page.click("text=Use a recovery code");
await page.fill("#code", codes[0].toUpperCase()); await page.click("button[type=submit]");
await page.waitForURL((u: URL) => u.pathname === "/", { timeout: 60000 }).catch(() => {});
ck("a recovery code signs in (any case)", new URL(page.url()).pathname === "/", page.url());
await signOut(); await signIn();
await page.click("text=Use a recovery code");
await page.fill("#code", codes[0]); await page.click("button[type=submit]");
ck("a used recovery code is refused", await seen("That code is not right"));
await waitNextStep();
await page.click("text=Use the app code instead");
await page.fill("#code", totpCode(key, totpStep())); await page.click("button[type=submit]");
await page.waitForURL((u: URL) => u.pathname === "/", { timeout: 60000 }).catch(() => {});

console.log("5. Turn off");
await page.goto(`${BASE}/account`);
ck("9 recovery codes left", await seen("9 of 10 recovery codes unused"));
await waitNextStep();
await page.fill("#off-password", "wrong-password"); await page.fill("#off-code", totpCode(key, totpStep())); await page.getByRole("button", { name: "Turn off", exact: true }).click();
ck("turning off needs the right password", await seen("That password is not right"));
await page.fill("#off-password", PASSWORD); await page.fill("#off-code", totpCode(key, totpStep())); await page.getByRole("button", { name: "Turn off", exact: true }).click();
const offShown = await seen("Set up two-factor login", 10000);


ck("turning off with password and code works (page shows Off again)", offShown);
await signOut(); await signIn();
ck("after turning off, the password alone signs in again", new URL(page.url()).pathname === "/", page.url());

await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/account`);
ck("account page fits a phone (no sideways scroll)", (await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)) <= 0);
await browser.close();
console.log(`\n${pass} passed, ${fail.length} failed${fail.length ? ": " + fail.join("; ") : ""}`);
process.exit(fail.length ? 1 : 0);
