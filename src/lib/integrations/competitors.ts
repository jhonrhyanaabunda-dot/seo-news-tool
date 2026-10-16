import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { competitors, dealerships, type Competitor } from "@/lib/db/schema";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/security/ssrf";
import { cleanText } from "@/lib/security/sanitize";
import { canonicalHost } from "@/lib/seo/url";
import { MAX_COMPETITORS } from "./competitor-metrics";

export type AddCompetitorResult = { ok: true; competitor: Competitor } | { ok: false; field: "name" | "websiteUrl" | "form"; error: string };

/**
 * Add a competitor website to a dealership. The address goes through the same
 * SSRF validation as dealership websites (public host, http(s), ports 80/443)
 * and is re-validated on every fetch by the fetcher.
 */
export async function addCompetitor(dealershipId: number, input: { name: unknown; websiteUrl: unknown }): Promise<AddCompetitorResult> {
  const name = cleanText(input.name, 200);
  if (name.length < 2) return { ok: false, field: "name", error: "Enter the competitor's name." };
  const rawUrl = cleanText(input.websiteUrl, 500);
  if (!rawUrl) return { ok: false, field: "websiteUrl", error: "Enter the competitor's website address." };
  let url: URL;
  try {
    url = (await assertSafeUrl(/^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)).url;
  } catch (err) {
    const msg = err instanceof UnsafeUrlError ? err.message : "The website address could not be verified";
    return { ok: false, field: "websiteUrl", error: `${msg}. Enter the competitor's public website address.` };
  }
  // Compare homepages only: the audit always requests the site root.
  const homepage = `${url.protocol}//${url.host}/`;
  const host = canonicalHost(url.hostname);

  const [d] = await db.select({ host: dealerships.host }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d) return { ok: false, field: "form", error: "This dealership no longer exists." };
  if (d.host === host) return { ok: false, field: "websiteUrl", error: "That is the dealership's own website." };
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(competitors).where(eq(competitors.dealershipId, dealershipId));
  if (n >= MAX_COMPETITORS) return { ok: false, field: "form", error: `A dealership can be compared with up to ${MAX_COMPETITORS} competitors. Remove one first.` };

  const [row] = await db.insert(competitors).values({ dealershipId, name, websiteUrl: homepage, host }).onConflictDoNothing().returning();
  if (!row) return { ok: false, field: "websiteUrl", error: "This competitor is already listed." };
  return { ok: true, competitor: row };
}

export async function removeCompetitor(dealershipId: number, competitorId: number): Promise<boolean> {
  const rows = await db.delete(competitors).where(and(eq(competitors.id, competitorId), eq(competitors.dealershipId, dealershipId))).returning({ id: competitors.id });
  return rows.length > 0;
}

export async function listCompetitors(dealershipId: number): Promise<Competitor[]> {
  return db.select().from(competitors).where(eq(competitors.dealershipId, dealershipId)).orderBy(competitors.createdAt, competitors.id);
}
