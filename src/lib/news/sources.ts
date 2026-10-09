import "server-only";
import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships, newsSources, type Dealership, type NewsSource } from "@/lib/db/schema";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/security/ssrf";
import { cleanText } from "@/lib/security/sanitize";

const MAX_SOURCES_PER_DEALERSHIP = 20;

/** Enabled feeds for a dealership: its own, plus manufacturer feeds shared by every dealership of its brand. */
export async function sourcesForDealership(d: Dealership): Promise<NewsSource[]> {
  return db
    .select()
    .from(newsSources)
    .where(and(eq(newsSources.isEnabled, true), or(eq(newsSources.dealershipId, d.id), and(isNull(newsSources.dealershipId), sql`lower(${newsSources.brand}) = lower(${d.brand})`))))
    .orderBy(asc(newsSources.id));
}

export async function listSourcesForAdmin(d: Dealership): Promise<NewsSource[]> {
  return db
    .select()
    .from(newsSources)
    .where(or(eq(newsSources.dealershipId, d.id), and(isNull(newsSources.dealershipId), sql`lower(${newsSources.brand}) = lower(${d.brand})`)))
    .orderBy(asc(newsSources.sourceType), asc(newsSources.label));
}

export async function addNewsSource(input: { dealershipId: number; sourceType: string; label: string; url: string; allBrandDealerships: boolean }): Promise<string | null> {
  const type = input.sourceType === "dealership" || input.sourceType === "manufacturer" || input.sourceType === "rss" ? input.sourceType : null;
  if (!type) return "Choose a source type.";
  const label = cleanText(input.label, 200);
  if (label.length < 2) return "Give the source a name.";
  let url: string;
  try {
    url = (await assertSafeUrl(input.url.trim())).url.toString();
  } catch (err) {
    return err instanceof UnsafeUrlError ? `That address cannot be used: ${err.message}.` : "Enter the full feed address, e.g. https://www.example.com/feed/";
  }
  const [d] = await db.select().from(dealerships).where(eq(dealerships.id, input.dealershipId)).limit(1);
  if (!d) return "Dealership not found.";
  // Only manufacturer newsrooms are shared across a brand; a dealership's own feed belongs to that dealership.
  const shared = type === "manufacturer" && input.allBrandDealerships;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(newsSources).where(eq(newsSources.dealershipId, d.id));
  if (!shared && Number(n) >= MAX_SOURCES_PER_DEALERSHIP) return `A dealership can have at most ${MAX_SOURCES_PER_DEALERSHIP} feeds.`;
  const inserted = await db
    .insert(newsSources)
    .values({ dealershipId: shared ? null : d.id, brand: shared ? d.brand : null, sourceType: type, label, url })
    .onConflictDoNothing()
    .returning({ id: newsSources.id });
  return inserted.length ? null : "That feed has already been added.";
}

/**
 * Remove a news source, but only one that the given dealership actually has.
 *
 * The id arrives from a form, so it proves nothing on its own; the delete has
 * to match the same set `listSourcesForAdmin` shows for this dealership — its
 * own sources, plus the shared ones for its brand. Deleting by id alone would
 * let a posted id reach a source belonging to a dealership the caller is not
 * working on. Returns whether a row was removed, so the caller can tell a
 * mismatch from an already-deleted source.
 */
export async function removeNewsSource(sourceId: number, dealership: Pick<Dealership, "id" | "brand">): Promise<boolean> {
  const removed = await db
    .delete(newsSources)
    .where(
      and(
        eq(newsSources.id, sourceId),
        or(eq(newsSources.dealershipId, dealership.id), and(isNull(newsSources.dealershipId), sql`lower(${newsSources.brand}) = lower(${dealership.brand})`)),
      ),
    )
    .returning({ id: newsSources.id });
  return removed.length > 0;
}

export async function recordSourceFetch(sourceId: number, error: string | null): Promise<void> {
  await db
    .update(newsSources)
    .set({ lastFetchedAt: new Date(), lastStatus: error ? "error" : "ok", lastError: error ? error.slice(0, 1000) : null, updatedAt: new Date() })
    .where(eq(newsSources.id, sourceId));
}
