import "server-only";
import { and, asc, desc, eq, isNotNull, isNull, ne, notLike, or, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { newsArticles } from "@/lib/db/schema";
import { logger, errorMessage } from "@/lib/logger";
import { safeFetch } from "@/lib/seo/fetcher";
import { detectBlock } from "@/lib/seo/block-detect";
import { loadRobots } from "@/lib/seo/robots";
import { getCached, setCached } from "@/lib/seo/site-cache";
import { canonicalHost } from "@/lib/seo/url";
import { extractArticleMeta, findInNewsSitemap, pageTimeMatchesFeed, parseNewsSitemap, type NewsSitemapEntry } from "./article-meta";

/** Articles filled in per news check; the rest are picked up by later checks. */
const MAX_PER_RUN = 12;
const PAUSE_MS = 500;
/** A publisher's news sitemap changes as it publishes; reuse a copy for 30 minutes across dealerships. */
const NEWS_SITEMAP_CACHE_HOURS = 0.5;
const MAX_CHILD_SITEMAPS = 2;

const GOOGLE_NEWS_LINK = "https://news.google.com/%";

/** Request a publisher resource only where its robots.txt allows the monitor. */
async function politeGet(url: string, opts: { accept?: string; maxBytes?: number } = {}): Promise<string | null> {
  const robots = await loadRobots(url);
  if (!robots.isAllowed(url)) return null;
  const res = await safeFetch(url, { retries: 0, timeoutMs: 10_000, maxBytes: opts.maxBytes ?? 2 * 1024 * 1024, accept: opts.accept });
  if (!res.ok || !res.body || detectBlock(res).blocked) return null;
  return res.body;
}

/** Recent articles from the news sitemaps a publisher lists in its robots.txt. */
async function publisherNewsSitemap(publisherUrl: string): Promise<NewsSitemapEntry[]> {
  const host = canonicalHost(new URL(publisherUrl).hostname);
  const cached = await getCached<Array<{ loc: string; title: string; publishedAt: string }>>(host, "news-sitemap", NEWS_SITEMAP_CACHE_HOURS);
  if (cached) return cached.map((e) => ({ ...e, publishedAt: new Date(e.publishedAt) }));

  const robots = await loadRobots(publisherUrl);
  const entries: NewsSitemapEntry[] = [];
  const accept = "application/xml,text/xml,*/*;q=0.8";
  for (const sitemapUrl of robots.sitemaps.filter((s) => /news/i.test(s)).slice(0, 2)) {
    const xml = await politeGet(sitemapUrl, { accept, maxBytes: 8 * 1024 * 1024 });
    if (!xml) continue;
    const parsed = parseNewsSitemap(xml);
    entries.push(...parsed.entries);
    for (const child of parsed.children.slice(0, MAX_CHILD_SITEMAPS)) {
      const childXml = await politeGet(child, { accept, maxBytes: 8 * 1024 * 1024 });
      if (childXml) entries.push(...parseNewsSitemap(childXml).entries);
    }
  }
  await setCached(host, "news-sitemap", entries);
  return entries;
}

/**
 * Fill in the exact publication time, a description and the direct article link
 * for articles whose feed lacked them.
 *
 *  • Direct publisher links: the article page's own JSON-LD / meta tags.
 *  • Google News links: news.google.com disallows automated access to its article
 *    links, so they are never followed. Instead the headline is looked up in the
 *    publisher's news sitemap (listed in the publisher's robots.txt), which gives
 *    the direct URL and publication timestamp; the description then comes from
 *    that page. Only recent stories are listed there, so this works for articles
 *    as they are detected.
 *
 * Each article is attempted once, with the monitor's own user agent, and only
 * where the publisher's robots.txt allows it.
 */
export async function enrichArticles(opts: { dealershipId?: number; limit?: number } = {}): Promise<{ attempted: number; timesFound: number; summariesFound: number; linksFound: number }> {
  const where: SQL[] = [
    isNull(newsArticles.enrichedAt),
    or(notLike(newsArticles.url, GOOGLE_NEWS_LINK), isNotNull(newsArticles.publisherUrl))!,
    or(isNull(newsArticles.summary), isNull(newsArticles.publishedPrecision), ne(newsArticles.publishedPrecision, "datetime"))!,
  ];
  if (opts.dealershipId) where.push(eq(newsArticles.dealershipId, opts.dealershipId));
  const rows = await db
    .select({
      id: newsArticles.id,
      url: newsArticles.url,
      title: newsArticles.title,
      source: newsArticles.source,
      summary: newsArticles.summary,
      publishedAt: newsArticles.publishedAt,
      precision: newsArticles.publishedPrecision,
      publisherUrl: newsArticles.publisherUrl,
    })
    .from(newsArticles)
    .where(and(...where))
    // This store's own news first, newest first.
    .orderBy(asc(newsArticles.scope), desc(newsArticles.detectedAt))
    .limit(opts.limit ?? MAX_PER_RUN);

  let timesFound = 0;
  let summariesFound = 0;
  let linksFound = 0;
  for (const [i, a] of rows.entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, PAUSE_MS));
    const update: Partial<typeof newsArticles.$inferInsert> = { enrichedAt: new Date() };
    // The publisher's own timestamp is preferred over an aggregator's, which is sometimes the time Google re-indexed the story.
    const setTime = (t: Date, fromPublisher: boolean) => {
      if ((a.precision === "datetime" && !fromPublisher) || !pageTimeMatchesFeed(t, a.publishedAt)) return;
      update.publishedAt = t;
      update.publishedPrecision = "datetime";
      timesFound++;
    };
    try {
      let articleUrl: string | null = a.url;
      if (a.url.startsWith("https://news.google.com/")) {
        const match = a.publisherUrl ? findInNewsSitemap(a.title, a.source, a.publishedAt, await publisherNewsSitemap(a.publisherUrl)) : null;
        articleUrl = match?.loc ?? null;
        if (match) {
          update.originalUrl = match.loc.slice(0, 2000);
          linksFound++;
          setTime(match.publishedAt, true);
        }
      }
      if (articleUrl && (!a.summary || !update.publishedPrecision)) {
        const html = await politeGet(articleUrl);
        if (html) {
          const meta = extractArticleMeta(html, a.title);
          if (meta.publishedAt && !update.publishedPrecision) setTime(meta.publishedAt, a.url.startsWith("https://news.google.com/"));
          if (meta.description && !a.summary) {
            update.summary = meta.description;
            summariesFound++;
          }
        }
      }
    } catch (err) {
      await logger.warn("news", "Could not read publication details for an article", { url: a.url, error: errorMessage(err) });
    }
    await db.update(newsArticles).set(update).where(eq(newsArticles.id, a.id));
  }
  return { attempted: rows.length, timesFound, summariesFound, linksFound };
}
