/**
 * News source hierarchy. Pure functions.
 *
 *   1 dealership    the store's own news/blog feed — always about this store
 *   2 manufacturer  the brand's official newsroom — authoritative brand context
 *   3 rss           other publisher feeds an admin added — must mention our entities
 *   4 search        Google/Bing News RSS and news APIs — must mention our entities
 *   5 crawl         news/blog pages found on the dealership website by the crawler
 *
 * When the same story arrives from several sources, the most authoritative copy
 * is kept (see monitor.ts ordering).
 */
import { scoreArticle, topicsFor, type ArticleScore, type RelevanceKeyword } from "./relevance";
import type { NewsSourceType } from "@/lib/db/schema";
import { EXCLUDE_PATTERNS } from "./config";

export const SOURCE_PRIORITY: Record<NewsSourceType, number> = { dealership: 1, manufacturer: 2, rss: 3, search: 4, crawl: 5 };

export const SOURCE_LABEL: Record<NewsSourceType, string> = {
  dealership: "Official dealership news",
  manufacturer: "Manufacturer newsroom",
  rss: "News feed",
  search: "News search",
  crawl: "Dealership website",
};

/** An official source's own posts are relevant without having to repeat the store's name. */
const OFFICIAL_DEALERSHIP_SCORE = 60;
const MANUFACTURER_BASE_SCORE = 15;

export function scoreSourcedArticle(sourceType: NewsSourceType, text: string, entities: RelevanceKeyword[]): ArticleScore {
  // Exclusions (obituaries and similar) apply to every source, official ones included.
  if (EXCLUDE_PATTERNS.some((p) => p.test(text))) return { score: 0, matched: [], topics: [], scope: "brand" };
  const scored = scoreArticle(text, entities);
  switch (sourceType) {
    case "dealership":
    case "crawl":
      // Published by the dealership itself: its news by definition.
      return { score: Math.max(scored.score, OFFICIAL_DEALERSHIP_SCORE), matched: scored.matched, topics: scored.topics.length ? scored.topics : topicsFor(text), scope: "dealership" };
    case "manufacturer": {
      // Official brand news is kept even without naming the brand in the headline; a story naming this store stays dealership news.
      if (scored.score > 0 && scored.scope === "dealership") return scored;
      return { score: Math.max(scored.score, MANUFACTURER_BASE_SCORE), matched: scored.matched, topics: scored.topics.length ? scored.topics : topicsFor(text), scope: "brand" };
    }
    default:
      return scored;
  }
}
