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

// The database's session pooler admits 15 connections in all (Supabase free plan). A paused Vercel
// instance cannot close its idle connections, so they stay reserved until the instance is shut down;
// with 3 per instance plus the worker's 5, a few paused instances used every slot and pages failed
// with "max clients reached" (2026-11-02). Two per instance (postgres.js pipelines queries on a
// connection, which session mode allows) and a short idle timeout keep the footprint small.
function createClient() {
  const production = env().NODE_ENV === "production";
  return postgres(env().DATABASE_URL, {
    max: env().DATABASE_POOL_MAX ?? (production ? 2 : 5),
    idle_timeout: production ? 5 : 20,
    connect_timeout: 15,
    prepare: false,
  });
}

// Kept on globalThis in production too: the pool is the scarce resource here, so a module evaluated
// twice in one process (pages and route handlers can be separate bundles) must not open a second one.
export const sqlClient = globalForDb.__a3Sql ?? createClient();
globalForDb.__a3Sql = sqlClient;

export const db = drizzle(sqlClient, { schema });
export type Db = typeof db;
export { schema };
