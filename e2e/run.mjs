/**
 * Browser tests against a throwaway database: starts e2e/db-server.mjs (in-memory
 * PGlite), the app on port 3171 pointed only at it (email to the console, one DB
 * connection), runs every e2e/*.e2e.mts file, then stops both.
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

let failed = false;
try {
  await start("db", process.execPath, ["e2e/db-server.mjs"], { E2E_DB_PORT: String(DB_PORT) }, /READY/);
  await start(
    "app",
    process.execPath,
    [path.join("node_modules", "next", "dist", "bin", "next"), "dev", "-p", String(APP_PORT)],
    {
      DATABASE_URL: dbUrl,
      DATABASE_URL_UNPOOLED: dbUrl,
      DATABASE_POOL_MAX: "1",
      EMAIL_PROVIDER: "console",
      APP_URL: `http://localhost:${APP_PORT}`,
      AUTH_SECRET: "e2e-auth-secret-0123456789abcdef",
      CRON_SECRET: "e2e-cron-secret-0123456789",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    /Ready/,
  );
  await waitForHttp(`http://localhost:${APP_PORT}/login`);
  for (const file of readdirSync(path.join(repo, "e2e")).filter((f) => f.endsWith(".e2e.mts"))) {
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
