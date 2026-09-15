/**
 * Applies pending SQL migrations from ./drizzle to the database.
 * Run with: npm run db:migrate
 * Uses DATABASE_URL_UNPOOLED when set (direct connection; required for DDL on
 * some poolers), otherwise DATABASE_URL.
 */
import "./load-env";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  if (process.env.SKIP_DB_MIGRATE === "1") {
    console.log("SKIP_DB_MIGRATE=1 — skipping migrations.");
    return;
  }
  const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const sql = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
  const db = drizzle(sql);
  console.log("Applying migrations…");
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
  await sql.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
