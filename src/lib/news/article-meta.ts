/**
 * Publication details of a news article, from the feed and from the publisher's
 * own page. Pure functions (no network, no database) so the rules are tested.
 */
import * as cheerio from "cheerio";
import { jaccard, normalizeTitle, titleTokens } from "./relevance";

export type PublishedPrecision = "datetime" | "date";

/**
 * Whether a feed's publication timestamp carries a real time of day.
 * Google News reports stories whose publisher gave only a date at midnight
 * Pacific (07:00 or 08:00 UTC), and many feeds use midnight UTC; showing those
 * as a time would state a publication time nobody published.
 */
export function publishedPrecision(provider: string, publishedAt: Date | null): PublishedPrecision | null {
  if (!publishedAt) return null;
  const hms = publishedAt.getUTCMinutes() === 0 && publishedAt.getUTCSeconds() === 0 && publishedAt.getUTCMilliseconds() === 0;
  if (hms && publishedAt.getUTCHours() === 0) return "date";
  if (hms && provider === "google_rss" && (publishedAt.getUTCHours() === 7 || publishedAt.getUTCHours() === 8)) return "date";
  return "datetime";
}

export interface ArticlePageMeta {
  /** Publication time stated by the page, only when it includes a time of day. */
  publishedAt: Date | null;
  description: string | null;
}

/** An ISO-8601 value with a time component, e.g. 2026-08-21T14:05:00-05:00. Date-only values are ignored. */
function parseTimestamp(value: unknown): Date | null {
  if (typeof value !== "string" || !/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value)) return null;
  const d = new Date(value.trim());
  return Number.isNaN(d.getTime()) ? null : d;
}

function clean(text: string | undefined | null, max = 500): string | null {
  if (!text) return null;
  const t = text
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

const ARTICLE_TYPES = /^(NewsArticle|Article|ReportageNewsArticle|BlogPosting|AnalysisNewsArticle|LiveBlogPosting|WebPage)$/i;

function jsonLdDates(nodes: unknown[]): Date[] {
  const out: Date[] = [];
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 4) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const o = node as Record<string, unknown>;
    const types = ([] as unknown[]).concat(o["@type"] ?? []).map(String);
    if (types.some((t) => ARTICLE_TYPES.test(t))) {
      const d = parseTimestamp(o.datePublished);
      if (d) out.push(d);
    }
    if (o["@graph"]) visit(o["@graph"], depth + 1);
  };
  for (const n of nodes) visit(n, 0);
  return out;
}

/**
 * Read the publication time and description a publisher states in its own
 * markup: JSON-LD `datePublished`, then the standard meta tags. Nothing is
 * inferred from visible text, so a value is only returned when the page states it.
 */
export function extractArticleMeta(html: string, title: string): ArticlePageMeta {
  const $ = cheerio.load(html);
  const ld: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      ld.push(JSON.parse($(el).text()));
    } catch {
      /* malformed JSON-LD is common; skip it */
    }
  });
  const meta = (selector: string) => $(selector).first().attr("content");
  const publishedAt =
    jsonLdDates(ld)[0] ??
    parseTimestamp(meta('meta[property="article:published_time"]')) ??
    parseTimestamp(meta('meta[itemprop="datePublished"]')) ??
    parseTimestamp(meta('meta[name="parsely-pub-date"]')) ??
    parseTimestamp(meta('meta[name="publish-date"]')) ??
    parseTimestamp(meta('meta[name="date"]')) ??
    null;

  const normalizedTitle = title.toLowerCase().replace(/\W+/g, " ").trim();
  const description = [meta('meta[property="og:description"]'), meta('meta[name="description"]'), meta('meta[name="twitter:description"]')]
    .map((d) => clean(d))
    .find((d): d is string => d !== null && d.length >= 40 && !normalizedTitle.startsWith(d.toLowerCase().replace(/\W+/g, " ").trim()));

  return { publishedAt, description: description ?? null };
}

/**
 * Whether a time read from the page describes the same publication as the feed's
 * date. Pages sometimes state an update or a related story's date; a time more
 * than 36 hours away from the feed's date is not trusted.
 */
export function pageTimeMatchesFeed(pageTime: Date, feedDate: Date | null): boolean {
  if (!feedDate) return true;
  return Math.abs(pageTime.getTime() - feedDate.getTime()) <= 36 * 3_600_000;
}

export interface NewsSitemapEntry {
  loc: string;
  title: string;
  publishedAt: Date;
}

/**
 * Parse a publisher's Google News sitemap (or sitemap index). News sitemaps list
 * each recent article's direct URL, headline and full publication timestamp;
 * publishers maintain them for crawlers, typically covering the last two days.
 */
export function parseNewsSitemap(xml: string): { entries: NewsSitemapEntry[]; children: string[] } {
  const $ = cheerio.load(xml, { xml: true });
  const children = $("sitemapindex > sitemap > loc")
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((u) => /^https?:\/\//i.test(u));
  const entries: NewsSitemapEntry[] = [];
  $("urlset > url").each((_, el) => {
    const loc = $(el).children("loc").first().text().trim();
    const news = $(el).find("news\\:news, news").first();
    const title = news.find("news\\:title, title").first().text().trim();
    const publishedAt = parseTimestamp(news.find("news\\:publication_date, publication_date").first().text().trim());
    if (/^https?:\/\//i.test(loc) && title && publishedAt) entries.push({ loc, title, publishedAt });
  });
  return { entries, children };
}

/**
 * The news sitemap entry for a headline from an aggregator feed: the same
 * headline (ignoring the " - Publisher" suffix, punctuation and case) or a
 * near-identical one, published within 36 hours of the feed's date.
 */
export function findInNewsSitemap(title: string, source: string | null, feedDate: Date | null, entries: NewsSitemapEntry[]): NewsSitemapEntry | null {
  const target = normalizeTitle(title, source);
  const targetTokens = titleTokens(target);
  let best: { entry: NewsSitemapEntry; score: number } | null = null;
  for (const entry of entries) {
    if (!pageTimeMatchesFeed(entry.publishedAt, feedDate)) continue;
    const normalized = normalizeTitle(entry.title);
    const score = normalized === target ? 1 : jaccard(targetTokens, titleTokens(normalized));
    if (score >= 0.85 && (!best || score > best.score)) best = { entry, score };
  }
  return best?.entry ?? null;
}
