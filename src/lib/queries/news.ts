import "server-only";
import { and, asc, count, desc, eq, gte, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships, newsArticles } from "@/lib/db/schema";

export const NEWS_STATUSES = ["new", "relevant", "reviewed", "not_relevant"] as const;
export type NewsStatus = (typeof NEWS_STATUSES)[number];

/** "dealership" is the default view everywhere: brand & industry context is opt-in. */
export const NEWS_SCOPES = ["dealership", "brand", "all"] as const;
export type NewsScopeFilter = (typeof NEWS_SCOPES)[number];
export function parseNewsScope(v: string | undefined): NewsScopeFilter {
  return (NEWS_SCOPES as readonly string[]).includes(v ?? "") ? (v as NewsScopeFilter) : "dealership";
}

type NewsFilters = { dealershipId?: number; status?: string; minScore?: number; scope?: NewsScopeFilter };

function newsWhere(opts: NewsFilters): SQL | undefined {
  const where: SQL[] = [];
  if (opts.dealershipId) where.push(eq(newsArticles.dealershipId, opts.dealershipId));
  const scope = opts.scope ?? "dealership";
  if (scope !== "all") where.push(eq(newsArticles.scope, scope));
  if (opts.status && (NEWS_STATUSES as readonly string[]).includes(opts.status)) where.push(eq(newsArticles.relevance, opts.status as NewsStatus));
  if (opts.minScore) where.push(gte(newsArticles.relevanceScore, opts.minScore));
  return where.length ? and(...where) : undefined;
}

export async function getNews(opts: NewsFilters & { page: number; pageSize: number }) {
  const cond = newsWhere(opts);
  const [{ total }] = await db.select({ total: count() }).from(newsArticles).where(cond);
  const rows = await db
    .select({
      id: newsArticles.id,
      title: newsArticles.title,
      url: newsArticles.url,
      originalUrl: newsArticles.originalUrl,
      source: newsArticles.source,
      provider: newsArticles.provider,
      summary: newsArticles.summary,
      publishedAt: newsArticles.publishedAt,
      publishedPrecision: newsArticles.publishedPrecision,
      detectedAt: newsArticles.detectedAt,
      relevance: newsArticles.relevance,
      relevanceScore: newsArticles.relevanceScore,
      matchedKeywords: newsArticles.matchedKeywords,
      topics: newsArticles.topics,
      scope: newsArticles.scope,
      sourceType: newsArticles.sourceType,
      dealershipId: newsArticles.dealershipId,
      dealershipName: dealerships.name,
    })
    .from(newsArticles)
    .innerJoin(dealerships, eq(dealerships.id, newsArticles.dealershipId))
    .where(cond)
    // Newest publication first; articles without a publication date sort by when they were found.
    .orderBy(sql`coalesce(${newsArticles.publishedAt}, ${newsArticles.detectedAt}) desc`, desc(newsArticles.detectedAt), desc(newsArticles.id))
    .limit(opts.pageSize)
    .offset((opts.page - 1) * opts.pageSize);
  return { rows, total };
}

export async function getDealershipOptions() {
  return db.select({ id: dealerships.id, name: dealerships.name }).from(dealerships).orderBy(dealerships.name);
}

/**
 * The news feed split by dealership: every dealership with its matching article
 * count and its newest `perDealership` articles, so each store's news reads as
 * its own section.
 */
export async function getNewsByDealership(opts: NewsFilters & { perDealership: number }) {
  const cond = newsWhere(opts);
  const [dealers, counts] = await Promise.all([
    db
      .select({ id: dealerships.id, name: dealerships.name, brand: dealerships.brand, city: dealerships.city, state: dealerships.state, isActive: dealerships.isActive, newsEnabled: dealerships.newsEnabled })
      .from(dealerships)
      .where(opts.dealershipId ? eq(dealerships.id, opts.dealershipId) : undefined)
      .orderBy(asc(dealerships.name)),
    db.select({ dealershipId: newsArticles.dealershipId, total: count() }).from(newsArticles).where(cond).groupBy(newsArticles.dealershipId),
  ]);
  const totals = new Map(counts.map((c) => [c.dealershipId, Number(c.total)]));
  return Promise.all(
    dealers.map(async (d) => {
      const total = totals.get(d.id) ?? 0;
      const rows = total && opts.perDealership ? (await getNews({ ...opts, dealershipId: d.id, page: 1, pageSize: opts.perDealership })).rows : [];
      return { dealer: d, total, rows };
    }),
  );
}
