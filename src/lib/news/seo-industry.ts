import "server-only";
import { createHash } from "node:crypto";
import { and, asc, count, desc, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { seoArticles, seoFeeds, type SeoFeed } from "@/lib/db/schema";
import { logger, errorMessage } from "@/lib/logger";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/security/ssrf";
import { cleanText } from "@/lib/security/sanitize";
import { normalizeUrl } from "@/lib/seo/url";
import { FeedRateLimitedError } from "./feed-http";
import { fetchFeedIfChanged, fetchSourceFeed } from "./providers";
import { classifySeoArticle, cleanSeoSummary, cleanSeoTitle, pickTopStories, SEO_TOPIC_RULES } from "./seo-topics";

/**
 * SEO industry news: articles are read from the publications' RSS/Atom feeds
 * (headline, link, summary, date) — the publishers' websites are never crawled.
 */

/** Feed items older than this are ignored on first read, so adding a feed doesn't import its whole archive. */
const LOOKBACK_DAYS = 30;
const MAX_FEEDS = 40;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface IndustryNewsResult {
  feeds: number;
  fetched: number;
  inserted: number;
  /** Feeds that answered 304 Not Modified (nothing downloaded). */
  unchanged: number;
  /** Feeds skipped or paused because the publisher asked us to slow down. */
  paused: number;
  errors: number;
}

export async function runIndustryNewsFetch(): Promise<IndustryNewsResult> {
  const feeds = await db.select().from(seoFeeds).where(eq(seoFeeds.isEnabled, true)).orderBy(asc(seoFeeds.priority), asc(seoFeeds.id));
  const out: IndustryNewsResult = { feeds: feeds.length, fetched: 0, inserted: 0, unchanged: 0, paused: 0, errors: 0 };
  for (const feed of feeds) {
    if (feed.nextFetchAfter && feed.nextFetchAfter.getTime() > Date.now()) {
      out.paused++;
      continue;
    }
    try {
      const result = await fetchFeedIfChanged(feed.url, feed.label, LOOKBACK_DAYS, { etag: feed.etag, lastModified: feed.lastModified });
      if (result.notModified) {
        out.unchanged++;
        await db.update(seoFeeds).set({ lastFetchedAt: new Date(), lastStatus: "ok", lastError: null, nextFetchAfter: null, updatedAt: new Date() }).where(eq(seoFeeds.id, feed.id));
        continue;
      }
      const rows = result.articles.flatMap((a) => {
        let normalized: string;
        try {
          normalized = normalizeUrl(a.url);
        } catch {
          return []; // a malformed link in one item shouldn't lose the rest of the feed
        }
        if (!/^https?:/i.test(normalized) || a.url.length > 2000) return [];
        const title = cleanSeoTitle(a.title);
        const summary = cleanSeoSummary(a.summary, title);
        const { topics, importance } = classifySeoArticle(title, summary, feed.priority);
        return {
          feedId: feed.id,
          title,
          url: a.url,
          urlHash: sha(normalized),
          source: feed.label,
          summary,
          // A feed item dated in the future is a publisher mistake; treat it as published now.
          publishedAt: a.publishedAt && a.publishedAt.getTime() > Date.now() ? new Date() : a.publishedAt,
          topics,
          importance,
        };
      });
      out.fetched += rows.length;
      if (rows.length) {
        const inserted = await db.insert(seoArticles).values(rows).onConflictDoNothing().returning({ id: seoArticles.id });
        out.inserted += inserted.length;
      }
      await db
        .update(seoFeeds)
        .set({ lastFetchedAt: new Date(), lastStatus: "ok", lastError: null, etag: result.etag, lastModified: result.lastModified, nextFetchAfter: null, updatedAt: new Date() })
        .where(eq(seoFeeds.id, feed.id));
    } catch (err) {
      if (err instanceof FeedRateLimitedError) {
        out.paused++;
        const until = new Date(Date.now() + err.retryAfterMs);
        await db.update(seoFeeds).set({ lastFetchedAt: new Date(), lastStatus: "rate_limited", lastError: err.message, nextFetchAfter: until, updatedAt: new Date() }).where(eq(seoFeeds.id, feed.id));
        await logger.info("seo-news", `Feed "${feed.label}" paused until ${until.toISOString()}`, { url: feed.url, status: err.status, reason: err.message });
        continue;
      }
      out.errors++;
      await db
        .update(seoFeeds)
        .set({ lastFetchedAt: new Date(), lastStatus: "error", lastError: errorMessage(err).slice(0, 1000), updatedAt: new Date() })
        .where(eq(seoFeeds.id, feed.id));
      await logger.warn("seo-news", `Feed "${feed.label}" could not be read`, { url: feed.url, error: errorMessage(err) });
    }
  }
  if (out.errors > 0 && out.errors === feeds.length - out.paused) throw new Error("No SEO news feed could be read; see Admin → System for details.");
  return out;
}

/* ───────────────────────────── Feeds (admin) ───────────────────────────── */

export async function listSeoFeeds(): Promise<Array<SeoFeed & { articles: number; paused: boolean }>> {
  const counts = db.select({ feedId: seoArticles.feedId, n: count().as("n") }).from(seoArticles).groupBy(seoArticles.feedId).as("c");
  const rows = await db
    .select({ feed: seoFeeds, articles: sql<number>`coalesce(${counts.n}, 0)::int`, paused: sql<boolean>`coalesce(${seoFeeds.nextFetchAfter} > now(), false)` })
    .from(seoFeeds)
    .leftJoin(counts, eq(counts.feedId, seoFeeds.id))
    .orderBy(asc(seoFeeds.priority), asc(seoFeeds.label));
  return rows.map((r) => ({ ...r.feed, articles: Number(r.articles), paused: Boolean(r.paused) }));
}

export async function addSeoFeed(input: { label: string; url: string; official: boolean }): Promise<string | null> {
  const label = cleanText(input.label, 200);
  if (label.length < 2) return "Give the feed a name.";
  let url: string;
  try {
    url = (await assertSafeUrl(input.url.trim())).url.toString();
  } catch (err) {
    return err instanceof UnsafeUrlError ? `That address cannot be used: ${err.message}.` : "Enter the full feed address, e.g. https://www.example.com/feed/";
  }
  const [{ n }] = await db.select({ n: count() }).from(seoFeeds);
  if (Number(n) >= MAX_FEEDS) return `At most ${MAX_FEEDS} feeds can be added.`;
  // Read it once before saving, so a web page address or a blocked feed is caught while the admin is still here.
  try {
    await fetchSourceFeed(url, label, LOOKBACK_DAYS);
  } catch (err) {
    return `That address didn't return a readable RSS/Atom feed (${errorMessage(err)}).`;
  }
  const inserted = await db
    .insert(seoFeeds)
    .values({ label, url, priority: input.official ? 1 : 3 })
    .onConflictDoNothing()
    .returning({ id: seoFeeds.id });
  return inserted.length ? null : "That feed has already been added.";
}

export async function setSeoFeedEnabled(id: number, enabled: boolean): Promise<void> {
  // Turning a feed back on is an explicit request to read it again, e.g. after the publisher allow-listed the crawler.
  await db.update(seoFeeds).set({ isEnabled: enabled, ...(enabled ? { nextFetchAfter: null } : {}), updatedAt: new Date() }).where(eq(seoFeeds.id, id));
}

export async function removeSeoFeed(id: number): Promise<void> {
  await db.delete(seoFeeds).where(eq(seoFeeds.id, id));
}

/* ───────────────────────────── Articles ───────────────────────────── */

export const SEO_NEWS_PERIODS = [7, 30, 90] as const;

export interface SeoNewsFilters {
  feedId?: number;
  topic?: string;
  days?: number;
}

/** Published (or, without a publication date, found) on or after `since`. */
const publishedSince = (since: Date) => sql`coalesce(${seoArticles.publishedAt}, ${seoArticles.detectedAt}) >= ${since.toISOString()}::timestamptz`;

function articleWhere(f: SeoNewsFilters): SQL | undefined {
  const where: SQL[] = [];
  if (f.feedId) where.push(eq(seoArticles.feedId, f.feedId));
  if (f.topic && SEO_TOPIC_RULES.some((r) => r.key === f.topic)) where.push(sql`${seoArticles.topics} @> ${JSON.stringify([f.topic])}::jsonb`);
  if (f.days) where.push(publishedSince(new Date(Date.now() - f.days * 86_400_000)));
  return where.length ? and(...where) : undefined;
}

const articleColumns = {
  id: seoArticles.id,
  title: seoArticles.title,
  url: seoArticles.url,
  source: seoArticles.source,
  summary: seoArticles.summary,
  publishedAt: seoArticles.publishedAt,
  detectedAt: seoArticles.detectedAt,
  topics: seoArticles.topics,
  importance: seoArticles.importance,
};

export async function getSeoNews(f: SeoNewsFilters & { page: number; pageSize: number }) {
  const cond = articleWhere(f);
  const [{ total }] = await db.select({ total: count() }).from(seoArticles).where(cond);
  const rows = await db
    .select(articleColumns)
    .from(seoArticles)
    .where(cond)
    .orderBy(sql`coalesce(${seoArticles.publishedAt}, ${seoArticles.detectedAt}) desc`, desc(seoArticles.id))
    .limit(f.pageSize)
    .offset((f.page - 1) * f.pageSize);
  return { rows, total: Number(total) };
}

export type SeoNewsItem = Awaited<ReturnType<typeof getSeoNews>>["rows"][number];

/** The week's top SEO stories for the newsletter (published or found since `since`). */
export async function getTopSeoStories(since: Date, limit = 8): Promise<SeoNewsItem[]> {
  const rows = await db
    .select(articleColumns)
    .from(seoArticles)
    .innerJoin(seoFeeds, eq(seoFeeds.id, seoArticles.feedId))
    .where(and(eq(seoFeeds.isEnabled, true), publishedSince(since)))
    .orderBy(desc(seoArticles.importance))
    .limit(300);
  return pickTopStories(rows, limit);
}

export async function pruneSeoArticles(retentionDays: number): Promise<number> {
  const r = await db.execute(sql`delete from seo_articles where detected_at < now() - make_interval(days => ${retentionDays}::int)`);
  return (r as unknown as { count?: number }).count ?? 0;
}
