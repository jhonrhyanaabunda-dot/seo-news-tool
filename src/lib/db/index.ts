import "server-only";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "@/lib/env";

/**
 * Database client.
 *
 * postgres.js with a tiny pool: serverless functions on Vercel are short-lived
 * and many may run concurrently, so each keeps at most a couple of connections
 * and relies on the provider's pooler (Neon pooler / Supabase pgbouncer /
 * RDS Proxy) for fan-in. `prepare: false` is required for transaction-mode
 * poolers. The client is cached on `globalThis` so hot reloads in dev do not
 * exhaust connections.
 */
const globalForDb = globalThis as unknown as { __a3Sql?: postgres.Sql };

function createClient() {
  return postgres(env().DATABASE_URL, {
    max: env().NODE_ENV === "production" ? 3 : 5,
    idle_timeout: 20,
    connect_timeout: 15,
    prepare: false,
  });
}

export const sqlClient = globalForDb.__a3Sql ?? createClient();
if (env().NODE_ENV !== "production") globalForDb.__a3Sql = sqlClient;

export const db = drizzle(sqlClient, { schema });
export type Db = typeof db;
export { schema };
