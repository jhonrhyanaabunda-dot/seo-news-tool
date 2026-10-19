/**
 * Browser tests against a throwaway database: starts e2e/db-server.mjs (in-memory
 * PGlite), builds the app and runs the PRODUCTION server on port 3171 pointed only
 * at it (email to the console, one DB connection), runs every e2e/*.e2e.mts file,
 * then stops both. Production mode matters: development React evaluates strings as
 * code, which a Content-Security-Policy check would flag although production never does.
 *
 *   npm run test:e2e
 */
import { spawn, execSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB_PORT = 5499;
const APP_PORT = 3171;
const dbUrl = `postgres://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;
const children = [];

function start(name, cmd, args, env, readyText) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: repo, env: { ...process.env, ...env } });
    children.push(child);
    const timer = setTimeout(() => reject(new Error(`${name} did not start within 4 minutes`)), 240_000);
    const onData = (buf) => {
      const text = buf.toString();
      if (process.env.E2E_VERBOSE) process.stdout.write(`[${name}] ${text}`);
      if (readyText.test(text)) {
        clearTimeout(timer);
        resolve(child);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("exit", (code) => reject(new Error(`${name} exited early (code ${code})`)));
  });
}

async function waitForHttp(url, ms = 240_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if ((await fetch(url)).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`${url} did not answer within ${ms / 1000}s`);
}

function stopAll() {
  for (const c of children) {
    if (c.exitCode !== null) continue;
    try {
      if (process.platform === "win32") execSync(`taskkill /PID ${c.pid} /T /F`, { stdio: "ignore" });
      else c.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

const appEnv = {
  DATABASE_URL: dbUrl,
  DATABASE_URL_UNPOOLED: dbUrl,
  DATABASE_POOL_MAX: "1",
  EMAIL_PROVIDER: "console",
  APP_URL: `http://localhost:${APP_PORT}`,
  AUTH_SECRET: "e2e-auth-secret-0123456789abcdef",
  CRON_SECRET: "e2e-cron-secret-0123456789",
  NEXT_TELEMETRY_DISABLED: "1",
};
const nextBin = path.join("node_modules", "next", "dist", "bin", "next");

let failed = false;
try {
  if (!process.env.E2E_SKIP_BUILD) {
    console.log("Building the app (production)…");
    await new Promise((resolve, reject) => {
      const b = spawn(process.execPath, [nextBin, "build"], { cwd: repo, env: { ...process.env, ...appEnv }, stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore" });
      b.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`next build failed (code ${code})`))));
    });
  }
  await start("db", process.execPath, ["e2e/db-server.mjs"], { E2E_DB_PORT: String(DB_PORT) }, /READY/);
  await start("app", process.execPath, [nextBin, "start", "-p", String(APP_PORT)], appEnv, /Ready|started server|Local:/);
  await waitForHttp(`http://localhost:${APP_PORT}/login`);
  for (const file of readdirSync(path.join(repo, "e2e")).filter((f) => f.endsWith(".e2e.mts") && (!process.env.E2E_ONLY || f.includes(process.env.E2E_ONLY)))) {
    console.log(`\n▶ ${file}`);
    const code = await new Promise((resolve) => {
      const t = spawn(process.execPath, [path.join("node_modules", "tsx", "dist", "cli.mjs"), path.join("e2e", file)], {
        cwd: repo,
        stdio: "inherit",
        env: { ...process.env, E2E_BASE_URL: `http://localhost:${APP_PORT}` },
      });
      t.on("exit", resolve);
    });
    if (code !== 0) failed = true;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  failed = true;
} finally {
  stopAll();
}
process.exit(failed ? 1 : 0);
