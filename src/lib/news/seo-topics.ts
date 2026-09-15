/**
 * SEO industry news topics — deterministic keyword matching on headline and
 * summary (no AI). Weights decide which stories lead the weekly newsletter;
 * topics that matter most to dealership websites weigh the most. Tune here.
 */

export interface SeoTopicRule {
  key: string;
  label: string;
  pattern: RegExp;
  weight: number;
}

export const SEO_TOPIC_RULES: SeoTopicRule[] = [
  {
    key: "google_update",
    label: "Google update",
    pattern: /\b(core update|algorithm update|spam update|ranking update|helpful content( update| system)?|reviews update|site reputation abuse|ranking volatility|search ranking (changes|shifts?))\b/i,
    weight: 40,
  },
  { key: "automotive", label: "Automotive", pattern: /\b(car dealers?(hips?)?|auto(motive)? dealers?(hips?)?|dealerships?|automotive|vehicle (listings?|inventory))\b/i, weight: 30 },
  { key: "local_seo", label: "Local SEO", pattern: /\b(local (seo|search|pack|rankings?|results)|google business profiles?|\bGBP\b|google maps|map pack|near me|local listings?|business reviews?)\b/i, weight: 30 },
  { key: "ai_search", label: "AI search", pattern: /\b(ai overviews?|ai mode|\bSGE\b|generative (search|engine)|chatgpt( search)?|perplexity|gemini|copilot|\bLLMs?\b|answer engines?|\bGEO\b)\b/i, weight: 20 },
  { key: "search_console", label: "Search Console", pattern: /\b(search console|bing webmaster tools|\bGSC\b)\b/i, weight: 15 },
  {
    key: "technical_seo",
    label: "Technical SEO",
    pattern: /\b(core web vitals|\bINP\b|\bLCP\b|crawl(ing|er|ability| budget)?|index(ing|ation|ability)|sitemaps?|robots\.txt|canonical(s|ization)?|structured data|schema markup|rich results|javascript seo|page speed|redirects?)\b/i,
    weight: 15,
  },
  { key: "google_ads", label: "Paid search", pattern: /\b(google ads|microsoft ads|performance max|\bPMax\b|\bPPC\b|paid search|search ads)\b/i, weight: 5 },
];

export const SEO_TOPIC_LABELS: Record<string, string> = Object.fromEntries(SEO_TOPIC_RULES.map((r) => [r.key, r.label]));

/** Extra weight for official search-engine sources (feed priority 1) and major SEO news publications (priority 2). */
const PRIORITY_BONUS: Record<number, number> = { 1: 25, 2: 10 };
/** Promotions are still listed on the SEO news page, but shouldn't lead the newsletter. */
const PROMO_PATTERN = /\b(webinars?|sponsored|register now|save your seat|podcast)\b/i;
const PROMO_PENALTY = 30;

/** Headline without publisher boilerplate, e.g. Search Engine Journal's trailing "via @sejournal, @author". */
export function cleanSeoTitle(title: string): string {
  return title.replace(/\s+via\s+@\w+(?:\s*,\s*@\w+)*\s*$/i, "").trim() || title;
}

/** Summary without WordPress's trailing "The post <headline> appeared first on <site>." (often cut mid-sentence by the feed). */
export function cleanSeoSummary(summary: string | null, title: string): string | null {
  if (!summary) return null;
  const i = summary.indexOf(`The post ${title.slice(0, 20)}`);
  const cleaned = (i >= 0 ? summary.slice(0, i) : summary).trim();
  return cleaned || null;
}

export function classifySeoArticle(title: string, summary: string | null, feedPriority: number): { topics: string[]; importance: number } {
  const text = `${title}\n${summary ?? ""}`;
  const matched = SEO_TOPIC_RULES.filter((r) => r.pattern.test(text));
  // The headline carries the story; a topic that only appears in the summary counts half.
  const importance =
    matched.reduce((sum, r) => sum + (r.pattern.test(title) ? r.weight : Math.round(r.weight / 2)), 0) + (PRIORITY_BONUS[feedPriority] ?? 0) - (PROMO_PATTERN.test(title) ? PROMO_PENALTY : 0);
  return { topics: matched.map((r) => r.key), importance: Math.max(0, Math.min(100, importance)) };
}

export interface RankableSeoArticle {
  id: number;
  source: string;
  importance: number;
  publishedAt: Date | null;
  detectedAt: Date;
}

/**
 * Pick the newsletter's top stories: highest importance first, newest breaking
 * ties, and at most `perSource` from one publication so a prolific blog can't
 * fill the whole list.
 */
export function pickTopStories<T extends RankableSeoArticle>(articles: T[], limit = 8, perSource = 3): T[] {
  const time = (a: T) => (a.publishedAt ?? a.detectedAt).getTime();
  const sorted = [...articles].sort((a, b) => b.importance - a.importance || time(b) - time(a) || b.id - a.id);
  const perSourceCount = new Map<string, number>();
  const out: T[] = [];
  for (const a of sorted) {
    const n = perSourceCount.get(a.source) ?? 0;
    if (n >= perSource) continue;
    perSourceCount.set(a.source, n + 1);
    out.push(a);
    if (out.length >= limit) break;
  }
  return out;
}
