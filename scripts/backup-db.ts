/**
 * Nightly database backup: every table as gzipped NDJSON (one row per line) from one consistent
 * snapshot, plus a manifest (row counts, applied migrations, git commit).
 *
 *   npm run db:backup                      # writes to BACKUP_DIR (default ~/Backups/a3-seo-monitor)
 *   npm run db:backup -- --keep-days 30    # retention (default 30)
 *
 * Why not pg_dump: production runs PostgreSQL 18 and pg_dump must be at least the
 * server's version. The schema itself lives in drizzle/ (migrations), so a restore
 * is: apply migrations to an empty database, then load these files in the order
 * the manifest lists (scripts/restore-db.ts).
 *
 * Read-only: one REPEATABLE READ, READ ONLY transaction. Sessions, rate-limit
 * counters and the site cache are skipped: they are disposable, and sessions are
 * bearer credentials that should not sit in a backup folder.
 */
import "./load-env";
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { execSync } from "node:child_process";
import { parseArgs } from "node:util";
import postgres from "postgres";

const SKIP = new Set(["sessions", "rate_limits", "site_cache"]);

async function main() {
  const { values } = parseArgs({ options: { "keep-days": { type: "string", default: "30" } } });
  const keepDays = Math.max(1, Number(values["keep-days"]) || 30);
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const root = process.env.BACKUP_DIR || path.join(homedir(), "Backups", "a3-seo-monitor");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const dir = path.join(root, stamp);
  mkdirSync(dir, { recursive: true });

  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const started = Date.now();
  const manifest: { createdAt: string; commit: string | null; server: string; migrations: number; tables: Array<{ name: string; file: string; rows: number; bytes: number }>; skipped: string[] } = {
    createdAt: new Date().toISOString(),
    commit: null,
    server: "",
    migrations: 0,
    tables: [],
    skipped: [...SKIP],
  };
  try {
    manifest.commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    /* not a git checkout */
  }

  try {
    await sql.begin("isolation level repeatable read read only", async (tx) => {
      manifest.server = (await tx`show server_version`)[0].server_version;
      manifest.migrations = Number((await tx`select count(*)::int n from drizzle.__drizzle_migrations`)[0].n);
      const tables = (await tx<{ name: string }[]>`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`).map((r) => r.name);
      const fks = await tx<{ child: string; parent: string }[]>`
        select ch.relname as child, pa.relname as parent from pg_constraint fk
        join pg_class ch on ch.oid = fk.conrelid join pg_class pa on pa.oid = fk.confrelid
        where fk.contype = 'f' and fk.conrelid <> fk.confrelid`;
      for (const name of loadOrder(tables, fks)) {
        if (SKIP.has(name)) continue;
        if (process.env.BACKUP_DEBUG) console.log(`  ${new Date().toISOString().slice(11, 19)} exporting ${name}…`);
        // One JSON object per row. jsonb_populate_recordset turns each back into the exact column
        // types on restore. (Streaming several COPY exports in one transaction stalled part-way.)
        const rows = await tx.unsafe<{ r: string }[]>(`select to_jsonb(t)::text as r from "${name.replace(/"/g, '""')}" t`);
        const file = `${name}.ndjson.gz`;
        const target = path.join(dir, file);
        const ndjson = rows.map((x) => x.r).join("\n") + (rows.length ? "\n" : "");
        writeFileSync(target, gzipSync(Buffer.from(ndjson), { level: 9 }));
        manifest.tables.push({ name, file, rows: rows.length, bytes: statSync(target).size });
      }
    });
  } finally {
    await sql.end();
  }
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  const totalRows = manifest.tables.reduce((a, t) => a + t.rows, 0);
  const totalBytes = manifest.tables.reduce((a, t) => a + t.bytes, 0);
  console.log(`Backup written: ${dir}`);
  console.log(`  ${manifest.tables.length} tables, ${totalRows} rows, ${(totalBytes / 1024).toFixed(0)} KB, ${manifest.migrations} migrations, PostgreSQL ${manifest.server}, ${Date.now() - started} ms`);

  // Retention: remove backup folders older than keepDays (only folders this script names).
  const cutoff = Date.now() - keepDays * 86_400_000;
  for (const entry of readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}$/.test(entry)) continue;
    const full = path.join(root, entry);
    if (entry !== stamp && statSync(full).mtimeMs < cutoff) {
      rmSync(full, { recursive: true, force: true });
      console.log(`  removed old backup ${entry}`);
    }
  }
}

if (process.argv[1]?.includes("backup-db")) main().catch((err) => {
  console.error(err);
  process.exit(1);
});

/**
 * Parents before children, so a restore can insert files in manifest order with
 * foreign keys enforced. A cycle (two tables referencing each other) is broken by
 * alphabetical order; the restore loads such a pair inside one deferred transaction.
 */
export function loadOrder(tables: string[], fks: Array<{ child: string; parent: string }>): string[] {
  const parents = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const { child, parent } of fks) if (parents.has(child) && parents.has(parent)) parents.get(child)!.add(parent);
  const done: string[] = [];
  const placed = new Set<string>();
  while (done.length < tables.length) {
    const ready = tables.filter((t) => !placed.has(t) && [...parents.get(t)!].every((p) => placed.has(p)));
    const next = ready.length ? ready : [tables.find((t) => !placed.has(t))!];
    for (const t of next) {
      placed.add(t);
      done.push(t);
    }
  }
  return done;
}
