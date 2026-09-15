import "server-only";
import * as cheerio from "cheerio";
import Parser from "rss-parser";
import { env } from "@/lib/env";
import { cleanText } from "@/lib/security/sanitize";
import { safeFetch } from "@/lib/seo/fetcher";
import { MAX_ARTICLES_PER_QUERY } from "./config";
import { conditionalHeaders, FeedRateLimitedError, parseRetryAfter } from "./feed-http";

/**
 * News source integrations. Each provider is isolated behind the same
 * interface so sources can be added, removed or replaced independently.
 *
 *  google_rss  Google News RSS search feed (public, no key) — official feed,
 *              not scraping of google.com search results.
 *  bing_rss    Bing News RSS search feed (public, no key).
 *  newsapi     NewsAPI.org /v2/everything (API key; note their free tier is
 *              for development only — production needs a paid plan).
 *  gnews       GNews.io /api/v4/search (API key).
 */

export interface RawArticle {
  title: string;
  url: string;
  source: string | null;
  publishedAt: Date | null;
  summary: string | null;
  provider: string;
  /** Publisher homepage named by an aggregator feed (Google News `<source url>`). */
  publisherUrl?: string | null;
}

export interface NewsProvider {
  id: string;
  label: string;
  isConfigured(): boolean;
  search(query: string, lookbackDays: number): Promise<RawArticle[]>;
}

type RssItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  contentSnippet?: string;
  content?: string;
  source?: string | { _?: string; $?: { url?: string } };
  /** The raw <source> element(s): the parser flattens `source` to its text, dropping the publisher's url attribute. */
  sourceNode?: Array<string | { _?: string; $?: { url?: string } }>;
  newsSource?: string;
};

const rss = new Parser<Record<string, never>, RssItem>({
  customFields: { item: ["source", ["source", "sourceNode", { keepArray: true }], ["News:Source", "newsSource"]] },
});

function htmlToText(input: string | undefined | null, max = 500): string | null {
  if (!input) return null;
  const text = cheerio.load(`<div>${input}</div>`)("div").text();
  return cleanText(text, max) || null;
}

function parseDate(s: string | undefined | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A feed body is only worth parsing when it actually looks like XML. */
function looksLikeFeed(body: string): boolean {
  return /^\s*(<\?xml|<rss|<feed|<rdf:RDF)/i.test(body);
}

/**
 * Fetch and parse an RSS feed.
 *
 * News search endpoints intermittently answer with something other than the
 * feed — a rate-limit notice, a consent page or truncated XML. Handing that to
 * the XML parser produces errors like "Unquoted attribute value / Line: 0" that
 * say nothing about the real problem, so the body is checked first and one
 * retry is made before the query is reported as failed.
 */
async function fetchFeed(url: string): Promise<RssItem[]> {
  const opts = { accept: "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.5", retries: 1, maxBytes: 4 * 1024 * 1024 } as const;
  let lastProblem = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await safeFetch(url, opts);
    if (!res.ok || !res.body) {
      lastProblem = `request failed (${res.status ?? res.errorCode ?? "no response"})`;
    } else if (!looksLikeFeed(res.body)) {
      // Report what actually came back rather than a parser's internal complaint.
      const kind = res.contentType?.split(";")[0] ?? "unknown content type";
      lastProblem = `the feed endpoint returned ${kind} instead of a feed (likely rate limiting or a challenge page)`;
    } else {
      try {
        const feed = await rss.parseString(res.body);
        return (feed.items ?? []).slice(0, MAX_ARTICLES_PER_QUERY);
      } catch (err) {
        lastProblem = `the feed could not be parsed (${(err instanceof Error ? err.message : String(err)).split("\n")[0]})`;
      }
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error(`Feed unavailable: ${lastProblem}`);
}

/** Publisher homepage from Google News' `<source url="…">`, when it is a plain web address. */
function publisherUrlOf(i: RssItem): string | null {
  const node = i.sourceNode?.[0];
  const url = typeof node === "object" ? node.$?.url : undefined;
  return url && /^https?:\/\/[^\s]+$/i.test(url) ? url.slice(0, 500) : null;
}

const googleRss: NewsProvider = {
  id: "google_rss",
  label: "Google News",
  isConfigured: () => true,
  async search(query, lookbackDays) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${lookbackDays}d`)}&hl=en-US&gl=US&ceid=US:en`;
    const items = await fetchFeed(url);
    return items
      .filter((i) => i.title && i.link)
      .map((i) => {
        const source = typeof i.source === "string" ? i.source : (i.source?._ ?? null);
        return {
          title: cleanText(i.title, 500),
          url: i.link!,
          source: source ? cleanText(source, 200) : null,
          publishedAt: parseDate(i.isoDate ?? i.pubDate),
          summary: null, // Google News descriptions only repeat the headline + source links.
          provider: "google_rss",
          publisherUrl: publisherUrlOf(i),
        };
      });
  },
};

const bingRss: NewsProvider = {
  id: "bing_rss",
  label: "Bing News",
  isConfigured: () => true,
  async search(query) {
    const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=rss&setlang=en-US&cc=US`;
    const items = await fetchFeed(url);
    return items
      .filter((i) => i.title && i.link)
      .map((i) => {
        let link = i.link!;
        try {
          const u = new URL(link);
          const target = u.searchParams.get("url");
          if (/bing\.com$/i.test(u.hostname) && target) link = target;
        } catch {
          /* keep original */
        }
        return {
          title: cleanText(i.title, 500),
          url: link,
          source: i.newsSource ? cleanText(i.newsSource, 200) : null,
          publishedAt: parseDate(i.isoDate ?? i.pubDate),
          summary: htmlToText(i.contentSnippet ?? i.content),
          provider: "bing_rss",
        };
      });
  },
};

const newsApi: NewsProvider = {
  id: "newsapi",
  label: "NewsAPI.org",
  isConfigured: () => Boolean(env().NEWSAPI_KEY),
  async search(query, lookbackDays) {
    const from = new Date(Date.now() - lookbackDays * 86_400_000).toISOString().slice(0, 10);
    const url = new URL("https://newsapi.org/v2/everything");
    url.searchParams.set("q", query);
    url.searchParams.set("language", "en");
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("from", from);
    url.searchParams.set("pageSize", String(MAX_ARTICLES_PER_QUERY));
    const res = await fetch(url, { headers: { "X-Api-Key": env().NEWSAPI_KEY! }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`NewsAPI returned HTTP ${res.status}`);
    const data = (await res.json()) as { articles?: Array<{ title?: string; url?: string; source?: { name?: string }; publishedAt?: string; description?: string }> };
    return (data.articles ?? [])
      .filter((a) => a.title && a.url && a.title !== "[Removed]")
      .map((a) => ({
        title: cleanText(a.title, 500),
        url: a.url!,
        source: a.source?.name ? cleanText(a.source.name, 200) : null,
        publishedAt: parseDate(a.publishedAt),
        summary: htmlToText(a.description),
        provider: "newsapi",
      }));
  },
};

const gnews: NewsProvider = {
  id: "gnews",
  label: "GNews",
  isConfigured: () => Boolean(env().GNEWS_API_KEY),
  async search(query, lookbackDays) {
    const url = new URL("https://gnews.io/api/v4/search");
    url.searchParams.set("q", query);
    url.searchParams.set("lang", "en");
    url.searchParams.set("country", "us");
    url.searchParams.set("max", "25");
    url.searchParams.set("from", new Date(Date.now() - lookbackDays * 86_400_000).toISOString());
    url.searchParams.set("apikey", env().GNEWS_API_KEY!);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`GNews returned HTTP ${res.status}`);
    const data = (await res.json()) as { articles?: Array<{ title?: string; url?: string; source?: { name?: string }; publishedAt?: string; description?: string }> };
    return (data.articles ?? [])
      .filter((a) => a.title && a.url)
      .map((a) => ({
        title: cleanText(a.title, 500),
        url: a.url!,
        source: a.source?.name ? cleanText(a.source.name, 200) : null,
        publishedAt: parseDate(a.publishedAt),
        summary: htmlToText(a.description),
        provider: "gnews",
      }));
  },
};

export const ALL_PROVIDERS: NewsProvider[] = [googleRss, bingRss, newsApi, gnews];

/** Items of a configured RSS/Atom feed (dealership news, manufacturer newsroom, publisher feed). */
export async function fetchSourceFeed(url: string, sourceLabel: string, lookbackDays: number): Promise<RawArticle[]> {
  return feedArticles(await fetchFeed(url), sourceLabel, lookbackDays);
}

export type ConditionalFeedResult = { notModified: true } | { notModified: false; articles: RawArticle[]; etag: string | null; lastModified: string | null };

/**
 * Read a feed only if it changed since the last read (ETag / Last-Modified), for
 * feeds polled on a schedule. HTTP 429/503 throws FeedRateLimitedError with the
 * publisher's requested pause, and is never retried.
 */
export async function fetchFeedIfChanged(url: string, sourceLabel: string, lookbackDays: number, validators: { etag: string | null; lastModified: string | null }): Promise<ConditionalFeedResult> {
  const res = await safeFetch(url, { accept: "application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,*/*;q=0.5", retries: 1, maxBytes: 4 * 1024 * 1024, headers: conditionalHeaders(validators) });
  if (res.status === 304) return { notModified: true };
  if (res.status === 429 || res.status === 503) throw new FeedRateLimitedError(res.status, parseRetryAfter(res.headers["retry-after"]));
  if (!res.ok || !res.body) throw new Error(`Feed unavailable: request failed (${res.status ?? res.errorCode ?? "no response"})`);
  if (!looksLikeFeed(res.body)) throw new Error(`Feed unavailable: the feed endpoint returned ${res.contentType?.split(";")[0] ?? "unknown content type"} instead of a feed`);
  let items: RssItem[];
  try {
    items = ((await rss.parseString(res.body)).items ?? []).slice(0, MAX_ARTICLES_PER_QUERY);
  } catch (err) {
    throw new Error(`Feed unavailable: the feed could not be parsed (${(err instanceof Error ? err.message : String(err)).split("\n")[0]})`);
  }
  return { notModified: false, articles: feedArticles(items, sourceLabel, lookbackDays), etag: res.headers["etag"]?.slice(0, 500) ?? null, lastModified: res.headers["last-modified"]?.slice(0, 100) ?? null };
}

function feedArticles(items: RssItem[], sourceLabel: string, lookbackDays: number): RawArticle[] {
  const cutoff = Date.now() - lookbackDays * 86_400_000;
  return items
    .filter((i) => i.title && i.link)
    .map((i) => ({
      title: cleanText(i.title, 500),
      url: i.link!,
      source: sourceLabel,
      publishedAt: parseDate(i.isoDate ?? i.pubDate),
      summary: htmlToText(i.contentSnippet ?? i.content),
      provider: "feed",
    }))
    .filter((a) => !a.publishedAt || a.publishedAt.getTime() >= cutoff);
}

export function activeProviders(): NewsProvider[] {
  const wanted = env()
    .NEWS_PROVIDERS.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ALL_PROVIDERS.filter((p) => wanted.includes(p.id) && p.isConfigured());
}
