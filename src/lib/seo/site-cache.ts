import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { siteCache } from "@/lib/db/schema";

/**
 * Per-host cache for data that rarely changes (robots.txt, sitemap URLs), so
 * scans don't re-download them every time. Fewer requests = less load on the
 * dealership's site and less chance of tripping its security systems.
 */
export async function getCached<T>(host: string, kind: string, maxAgeHours: number): Promise<T | null> {
  const [row] = await db
    .select()
    .from(siteCache)
    .where(and(eq(siteCache.host, host), eq(siteCache.kind, kind)))
    .limit(1);
  if (!row || Date.now() - row.fetchedAt.getTime() > maxAgeHours * 3_600_000) return null;
  return row.data as T;
}

export async function setCached(host: string, kind: string, data: unknown): Promise<void> {
  await db
    .insert(siteCache)
    .values({ host, kind, data, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: [siteCache.host, siteCache.kind], set: { data, fetchedAt: new Date() } });
}
