/**
 * Restore a backup written by scripts/backup-db.ts into an EMPTY database.
 *
 *   TARGET_DATABASE_URL=postgres://… npm run db:restore -- --from "C:\Users\…\Backups\a3-seo-monitor\2026-10-15T07-20-57"
 *
 * Steps: apply the repo's migrations (the schema), load every table in the
 * manifest's order (parents before children), move each id sequence past the
 * restored rows, then compare row counts with the manifest.
 *
 * Refuses to run against a database that already has dealerships, and against
 * the production host from .env.local unless --to-production is given — restoring
 * is for a new or replacement database, never for "undoing" a live one in place.
 */
import "./load-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parseArgs } from "node:util";

export interface Manifest {
  createdAt: string;
  migrations: number;
  tables: Array<{ name: string; file: string; rows: number }>;
}

/** Runs one statement with optional parameters and returns its rows. */
export type Exec = (query: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Load the backup's rows into a database whose schema is already migrated. */
export async function loadBackup(exec: Exec, dir: string, log: (line: string) => void = () => {}): Promise<Manifest> {
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8")) as Manifest;
  // Migrations seed some defaults (e.g. the SEO news feeds); the backup has the real rows, so the
  // seeds go first. Children before parents. Only ever run against a new database (see main).
  for (const t of [...manifest.tables].reverse()) await exec(`delete from ${quote(t.name)}`);
  for (const t of manifest.tables) {
    const lines = gunzipSync(readFileSync(path.join(dir, t.file))).toString("utf8").split("\n").filter(Boolean);
    for (let i = 0; i < lines.length; i += 500) {
      const batch = `[${lines.slice(i, i + 500).join(",")}]`;
      await exec(`insert into ${quote(t.name)} select * from jsonb_populate_recordset(null::${quote(t.name)}, $1::jsonb)`, [batch]);
    }
    // Serial ids continue after the restored rows, so new inserts never collide.
    const seqs = await exec(
      `select a.attname as col, pg_get_serial_sequence($1, a.attname) as seq from pg_attribute a
       where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and pg_get_serial_sequence($1, a.attname) is not null`,
      [quote(t.name)],
    );
    for (const s of seqs) await exec(`select setval($1, coalesce((select max(${quote(String(s.col))}) from ${quote(t.name)}), 0) + 1, false)`, [s.seq]);
    log(`  ${t.name}: ${lines.length} rows`);
  }
  return manifest;
}

/** Row counts per table in the restored database, compared with the manifest. */
export async function verifyRestore(exec: Exec, manifest: Manifest): Promise<string[]> {
  const problems: string[] = [];
  for (const t of manifest.tables) {
    const [r] = await exec(`select count(*)::int as n from ${quote(t.name)}`);
    if (Number(r.n) !== t.rows) problems.push(`${t.name}: expected ${t.rows} rows, found ${r.n}`);
  }
  return problems;
}

async function main() {
  const { values } = parseArgs({ options: { from: { type: "string" }, "to-production": { type: "boolean", default: false } } });
  const target = process.env.TARGET_DATABASE_URL;
  if (!values.from || !target) throw new Error('Usage: TARGET_DATABASE_URL=postgres://… npm run db:restore -- --from "<backup folder>"');
  const prodHost = (() => {
    try {
      return new URL(process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL || "").hostname.replace("-pooler", "");
    } catch {
      return null;
    }
  })();
  if (prodHost && new URL(target).hostname.replace("-pooler", "") === prodHost && !values["to-production"]) {
    throw new Error("TARGET_DATABASE_URL is the production database. Restore into a new database (e.g. a Neon branch), or pass --to-production deliberately.");
  }

  const { default: postgres } = await import("postgres");
  const { drizzle } = await import("drizzle-orm/postgres-js");
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  const sql = postgres(target, { max: 1, prepare: false, onnotice: () => {} });
  try {
    const [{ n }] = await sql`select count(*)::int as n from information_schema.tables where table_schema = 'public' and table_name = 'dealerships'`;
    if (n > 0 && Number((await sql`select count(*)::int as n from dealerships`)[0].n) > 0) throw new Error("The target database already has dealerships; restore only into an empty database.");
    console.log("Applying migrations…");
    await migrate(drizzle(sql), { migrationsFolder: "./drizzle" });
    console.log("Loading data…");
    const exec: Exec = (q, p) => sql.unsafe(q, (p ?? []) as never[]) as unknown as Promise<Array<Record<string, unknown>>>;
    const manifest = await sql.begin(async (tx) => loadBackup((q, p) => tx.unsafe(q, (p ?? []) as never[]) as unknown as Promise<Array<Record<string, unknown>>>, values.from!, console.log));
    const problems = await verifyRestore(exec, manifest);
    if (problems.length) throw new Error(`Restore finished but counts differ:\n${problems.join("\n")}`);
    console.log(`Restored ${manifest.tables.length} tables from the backup taken ${manifest.createdAt}; every row count matches.`);
  } finally {
    await sql.end();
  }
}

if (process.argv[1]?.includes("restore-db")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
