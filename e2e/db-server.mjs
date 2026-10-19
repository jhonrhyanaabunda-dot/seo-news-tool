// Throwaway PostgreSQL for the browser tests: in-memory PGlite with the app's own
// migrations and one test admin. Never touches a real database.
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const E2E_USER = { email: "e2e-admin@example.invalid", password: "E2E-test-password-123" };
const port = Number(process.env.E2E_DB_PORT ?? 5499);

const db = new PGlite();
const journal = JSON.parse(readFileSync(path.join(repo, "drizzle/meta/_journal.json"), "utf8"));
for (const e of journal.entries)
  for (const stmt of readFileSync(path.join(repo, "drizzle", `${e.tag}.sql`), "utf8").split("--> statement-breakpoint")) if (stmt.trim()) await db.exec(stmt);
await db.query("insert into users (email, name, password_hash, role) values ($1, $2, $3, 'admin')", [E2E_USER.email, "E2E Admin", await bcrypt.hash(E2E_USER.password, 10)]);
const server = new PGLiteSocketServer({ db, port, host: "127.0.0.1" });
await server.start();
console.log(`READY: ${journal.entries.length} migrations, test admin created, listening on 127.0.0.1:${port}`);
