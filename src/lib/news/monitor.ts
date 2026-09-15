import "server-only";
import { createHash } from "node:crypto";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships, newsArticles, newsKeywords, scanPages, seoScans, type NewsSourceType } from "@/lib/db/schema";
import { createAlert } from "@/lib/changes/alerts";
import { logger, errorMessage } from "@/lib/logger";
import { getSettings } from "@/lib/settings";
import { normalizeUrl } from "@/lib/seo/url";
import { MAX_BRAND_ONLY_PER_SCAN, NEAR_DUPLICATE_DAYS, TITLE_DEDUPE_DAYS } from "./config";
import { activeProviders, fetchSourceFeed, type RawArticle } from "./providers";
import { SOURCE_PRIORITY, scoreSourcedArticle } from "./source-rules";
import { recordSourceFetch, sourcesForDealership } from "./sources";
import { buildQueries, relevanceKeywords } from "./queries";
import { isNearDuplicate, normalizeTitle, titleTokens, type NewsScope } from "./relevance";
import { publishedPrecision } from "./article-meta";
import { enrichArticles } from "./enrich";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type SourcedArticle = RawArticle & { sourceType: NewsSourceType; newsSourceId: number | null };

/** Official manufacturer newsroom items kept per news check (they can publish many stories a day). */
const MAX_MANUFACTURER_PER_SCAN = 10;

export interface NewsScanResult {
  queries: number;
  /** Configured feeds read (dealership, manufacturer, publisher). */
  feeds?: number;
  fetched: number;
  inserted: number;
  relevant: number;
  providerErrors: number;
}

/**
 * Search all configured news sources for one dealership, de-duplicate
 * (by URL and by normalised headline) and store new articles with a
 * deterministic relevance score. Emits a "new relevant news" alert for the
 * next digest when high-relevance articles appear.
 */
export async function runNewsScan(dealershipId: number): Promise<NewsScanResult> {
  const [dealer] = await db.select().from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!dealer || !dealer.newsEnabled || !dealer.isActive) return { queries: 0, fetched: 0, inserted: 0, relevant: 0, providerErrors: 0 };
  const settings = await getSettings();
  const keywords = await db.select().from(newsKeywords).where(eq(newsKeywords.dealershipId, dealershipId));
  const queries = buildQueries(dealer, keywords);
  const entities = relevanceKeywords(dealer, keywords);
  const providers = activeProviders();
  const sources = await sourcesForDealership(dealer);
  if (!providers.length && !sources.length) throw new Error("No news sources are configured (add feeds or set NEWS_PROVIDERS).");

  const raw: SourcedArticle[] = [];
  let errors = 0;
  let attempts = 0;
  // 1–3) Configured feeds, most authoritative first: the dealership's own news, manufacturer newsrooms, publisher feeds.
  for (const src of [...sources].sort((a, b) => SOURCE_PRIORITY[a.sourceType] - SOURCE_PRIORITY[b.sourceType])) {
    attempts++;
    try {
      const items = await fetchSourceFeed(src.url, src.label, settings.newsLookbackDays);
      raw.push(...items.map((a) => ({ ...a, sourceType: src.sourceType as NewsSourceType, newsSourceId: src.id })));
      await recordSourceFetch(src.id, null);
    } catch (err) {
      errors++;
      await recordSourceFetch(src.id, errorMessage(err));
      await logger.warn("news", `Feed "${src.label}" could not be read`, { url: src.url, error: errorMessage(err) }, dealershipId);
    }
  }
  // 4) News search providers.
  for (const query of queries) {
    for (const provider of providers) {
      attempts++;
      try {
        raw.push(...(await provider.search(query.query, settings.newsLookbackDays)).map((a) => ({ ...a, sourceType: "search" as const, newsSourceId: null })));
      } catch (err) {
        errors++;
        await logger.warn("news", `${provider.label} search failed`, { query: query.query, error: errorMessage(err) }, dealershipId);
      }
      await sleep(250);
    }
  }
  if (attempts > 0 && errors === attempts) throw new Error("All news sources failed for this dealership; will retry.");

  // 5) News/blog pages the crawler already read on the dealership website (no extra requests to the site).
  const crawled = await crawledNewsPages(dealer.id);
  raw.push(...crawled);
  const [{ crawlSeen }] = await db.select({ crawlSeen: sql<number>`count(*)::int` }).from(newsArticles).where(and(eq(newsArticles.dealershipId, dealershipId), eq(newsArticles.sourceType, "crawl")));
  // The first time a site's news pages are seen they are a baseline, not "new news".
  const crawlBaseline = Number(crawlSeen) === 0;

  // Headlines already stored recently, for near-duplicate (same story, other outlet) detection.
  const recentTitles = await db
    .select({ title: newsArticles.title, source: newsArticles.source })
    .from(newsArticles)
    .where(and(eq(newsArticles.dealershipId, dealershipId), gte(newsArticles.detectedAt, new Date(Date.now() - NEAR_DUPLICATE_DAYS * 86_400_000))))
    .limit(2000);
  const storyTokens = recentTitles.map((r) => titleTokens(normalizeTitle(r.title, r.source)));
  const isSameStory = (tokens: Set<string>) => storyTokens.some((t) => isNearDuplicate(t, tokens));

  const cutoff = Date.now() - settings.newsLookbackDays * 86_400_000;

  // 1) Normalise and score every fetched article.
  type Candidate = { a: SourcedArticle; url: string; urlHash: string; titleKey: string; titleHash: string; score: number; matched: string[]; topics: string[]; scope: NewsScope };
  const scored: Candidate[] = [];
  for (const a of raw) {
    if (a.publishedAt && (a.publishedAt.getTime() < cutoff || a.publishedAt.getTime() > Date.now() + 86_400_000)) continue;
    let url: string;
    try {
      url = normalizeUrl(a.url);
    } catch {
      continue;
    }
    if (!/^https?:/i.test(url)) continue;
    const titleKey = normalizeTitle(a.title, a.source);
    if (!titleKey) continue;
    const { score, matched, topics, scope } = scoreSourcedArticle(a.sourceType, `${a.title} ${a.summary ?? ""}`, entities);
    if (score === 0) continue; // unrelated to this dealership, another store's news, or excluded (e.g. obituaries)
    scored.push({ a, url, urlHash: sha(url), titleKey, titleHash: sha(titleKey), score, matched, topics, scope });
  }

  // 2) Most authoritative source, then dealership stories, then most relevant, then most recent — so the best copy of each story is kept and caps keep the important ones.
  scored.sort((x, y) => SOURCE_PRIORITY[x.a.sourceType] - SOURCE_PRIORITY[y.a.sourceType] || (x.scope === y.scope ? 0 : x.scope === "dealership" ? -1 : 1) || y.score - x.score || (y.a.publishedAt?.getTime() ?? 0) - (x.a.publishedAt?.getTime() ?? 0) || (x.url < y.url ? -1 : 1));

  // 3) De-duplicate (URL, headline, near-duplicate story) and cap brand-only context stories.
  const batch = new Map<string, typeof newsArticles.$inferInsert>();
  const batchTitles = new Set<string>();
  let brandCount = 0;
  let manufacturerCount = 0;
  for (const c of scored) {
    if (batch.has(c.urlHash) || batchTitles.has(c.titleHash)) continue;
    const tokens = titleTokens(c.titleKey);
    if (isSameStory(tokens)) continue;
    if (c.scope === "brand" && c.a.sourceType === "manufacturer") {
      if (manufacturerCount >= MAX_MANUFACTURER_PER_SCAN) continue;
      manufacturerCount++;
    } else if (c.scope === "brand") {
      if (brandCount >= MAX_BRAND_ONLY_PER_SCAN) continue;
      brandCount++;
    }
    storyTokens.push(tokens);
    batchTitles.add(c.titleHash);
    batch.set(c.urlHash, {
      dealershipId,
      title: c.a.title,
      url: c.url.slice(0, 2000),
      urlHash: c.urlHash,
      titleHash: c.titleHash,
      source: c.a.source,
      provider: c.a.provider,
      summary: c.a.summary,
      publishedAt: c.a.publishedAt,
      publishedPrecision: publishedPrecision(c.a.provider, c.a.publishedAt),
      publisherUrl: c.a.publisherUrl ?? null,
      matchedKeywords: c.matched,
      topics: c.topics,
      relevanceScore: c.score,
      scope: c.scope,
      sourceType: c.a.sourceType,
      sourcePriority: SOURCE_PRIORITY[c.a.sourceType],
      newsSourceId: c.a.newsSourceId,
      ...(c.a.sourceType === "crawl" && crawlBaseline ? { relevance: "reviewed" as const } : {}),
    });
  }

  let candidates = [...batch.values()];
  if (candidates.length) {
    const since = new Date(Date.now() - TITLE_DEDUPE_DAYS * 86_400_000);
    const existing = await db
      .select({ titleHash: newsArticles.titleHash })
      .from(newsArticles)
      .where(and(eq(newsArticles.dealershipId, dealershipId), gte(newsArticles.detectedAt, since), inArray(newsArticles.titleHash, candidates.map((c) => c.titleHash))));
    const seen = new Set(existing.map((e) => e.titleHash));
    candidates = candidates.filter((c) => !seen.has(c.titleHash));
  }

  const inserted = candidates.length
    ? await db.insert(newsArticles).values(candidates).onConflictDoNothing().returning({ id: newsArticles.id, title: newsArticles.title, relevanceScore: newsArticles.relevanceScore, url: newsArticles.url, scope: newsArticles.scope })
    : [];
  // Articles stored before publisher websites were recorded pick theirs up from the same feed item.
  for (const c of scored) {
    if (!c.a.publisherUrl) continue;
    await db
      .update(newsArticles)
      .set({ publisherUrl: c.a.publisherUrl })
      .where(and(eq(newsArticles.dealershipId, dealershipId), eq(newsArticles.urlHash, c.urlHash), isNull(newsArticles.publisherUrl)));
  }

  // Brand & industry context never alerts, however high it scores: it is not this store's news.
  const relevant = inserted.filter((a) => a.scope === "dealership" && a.relevanceScore >= settings.newsAlertMinScore).sort((a, b) => b.relevanceScore - a.relevanceScore);

  if (relevant.length) {
    await createAlert({
      dealershipId,
      type: "new_relevant_news",
      severity: "info",
      title: `${dealer.name}: ${relevant.length} new relevant news article${relevant.length === 1 ? "" : "s"}`,
      message: relevant
        .slice(0, 5)
        .map((a) => `• ${a.title}`)
        .join("\n"),
      payload: { articleIds: relevant.map((a) => a.id) },
      dedupeKey: `news:${dealershipId}:${Math.min(...relevant.map((a) => a.id))}`,
    });
  }

  // Exact publication time and description from the publishers' pages, where the feed lacked them.
  try {
    await enrichArticles({ dealershipId });
  } catch (err) {
    await logger.warn("news", "Article details could not be filled in", { error: errorMessage(err) }, dealershipId);
  }

  await db.update(dealerships).set({ lastNewsScanAt: new Date() }).where(eq(dealerships.id, dealershipId));
  const result = { queries: queries.length, feeds: sources.length, fetched: raw.length, inserted: inserted.length, relevant: relevant.length, providerErrors: errors };
  await logger.info("news", "News scan complete", { ...result }, dealershipId);
  return result;
}

/**
 * News/blog pages from the latest completed scan of the dealership's website.
 * These were already fetched by the U.S. crawler, so reading them here costs
 * the dealership's site nothing and works even though Vercel never crawls it.
 */
async function crawledNewsPages(dealershipId: number): Promise<SourcedArticle[]> {
  const [scan] = await db
    .select({ id: seoScans.id })
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealershipId), eq(seoScans.status, "completed")))
    .orderBy(desc(seoScans.completedAt))
    .limit(1);
  if (!scan) return [];
  const pages = await db
    .select({ url: scanPages.url, finalUrl: scanPages.finalUrl, title: scanPages.title, metaDescription: scanPages.metaDescription })
    .from(scanPages)
    .where(and(eq(scanPages.scanId, scan.id), eq(scanPages.pageType, "blog"), eq(scanPages.status, "fetched"), isNotNull(scanPages.title), lt(scanPages.httpStatus, 400)))
    .limit(20);
  return pages
    .filter((p) => !/^(blog|news|articles?|events?|press)$/i.test((p.title ?? "").trim())) // index pages, not articles
    .map((p) => ({
      title: p.title!,
      url: p.finalUrl ?? p.url,
      source: "Dealership website",
      publishedAt: null,
      summary: p.metaDescription,
      provider: "crawl",
      sourceType: "crawl" as const,
      newsSourceId: null,
    }));
}
