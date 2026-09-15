/**
 * News relevance rules — deterministic keyword/topic matching (no AI).
 * Tune weights here; the relevance score is capped at 100.
 */

export const KEYWORD_WEIGHTS = {
  dealership: 60,
  group: 40,
  custom: 35,
  brand: 15,
  local: 15,
} as const;

export interface TopicRule {
  key: string;
  label: string;
  pattern: RegExp;
  weight: number;
}

export const TOPIC_RULES: TopicRule[] = [
  { key: "recall", label: "Recall", pattern: /\b(recall(s|ed|ing)?|safety (campaign|notice|recall)|nhtsa)\b/i, weight: 25 },
  { key: "award", label: "Award", pattern: /\b(awards?|awarded|honou?red|recogni[sz]ed|dealer of the year|president'?s (club|award)|named (top|best)|top workplace)\b/i, weight: 15 },
  { key: "community", label: "Community event", pattern: /\b(donat(e|es|ed|ion)|charity|sponsor(s|ed|ship)?|fundrais\w*|scholarship|volunteer\w*|toy drive|food drive|community event|giveback|give back)\b/i, weight: 15 },
  { key: "dealership_announcement", label: "Dealership announcement", pattern: /\b(grand opening|groundbreaking|ribbon[- ]cutting|new (showroom|facility|location|dealership)|acquir(es|ed|ing)|acquisition|expan(ds|sion|ding)|relocat\w*|renovat\w*|general manager|appoint(s|ed))\b/i, weight: 15 },
  { key: "new_model", label: "New model", pattern: /\b(unveil\w*|debut\w*|reveal(s|ed)?|all-new|redesign(ed)?|first look|new model|launch(es|ed)?|facelift|concept)\b/i, weight: 10 },
  { key: "manufacturer", label: "Manufacturer announcement", pattern: /\b(announce[sd]?|investment|plant|factory|production|electrif\w*|ev (plans?|strategy|lineup)|ceo|earnings|quarterly sales)\b/i, weight: 5 },
  { key: "industry", label: "Industry news", pattern: /\b(auto(motive)? industry|car sales|new-vehicle sales|tariffs?|auto loans?|vehicle inventory|dealer (network|groups?))\b/i, weight: 5 },
];

/** Articles matching any of these are dropped (e.g. an obituary for a person named "Price Ford"). */
export const EXCLUDE_PATTERNS: RegExp[] = [/\b(obituary|obituaries|funeral (home|service)|passed away|memorial service|in loving memory)\b/i];

/**
 * Near-duplicate stories: syndicated coverage of the same event ("Ford recalls
 * nearly 149,000 Mustangs…" from 20 outlets) is kept once. Two headlines are the
 * same story when the Jaccard similarity of their significant words reaches this.
 */
export const NEAR_DUPLICATE_THRESHOLD = 0.4;
/** Headlines citing the same large figure (e.g. "27,720 vehicles") are one story if they also share this many other words. */
export const NEAR_DUPLICATE_SHARED_FIGURE_WORDS = 2;

/** Articles that match only the city must also be about a dealership (not general local crime/news). */
export const LOCAL_CONTEXT_PATTERN = /\b(dealer|dealers|dealership|dealerships|auto group|automotive group)\b/i;

/*
 * Brand & industry stories — matched on the brand alone — are kept as context,
 * but only when they are about the manufacturer. A brand-only story naming a
 * dealership is by definition about someone else's store (ours would have
 * matched its own name, group or city), and a few other shapes are just the
 * brand name appearing in unrelated news.
 */

/** A dealership or retailer that isn't ours ("Agere Acquires BMW of Tri-Cities", "Retailer of the Year"). */
export const OTHER_DEALER_PATTERN = /\b(dealer|dealers|dealership|dealerships|retailer|retailers|showroom|auto group|automotive group)\b/i;
/**
 * "<Brand> of <Place>" is a store name — except the manufacturer's own national
 * arms. The place must be capitalised so "best BMW of all time" doesn't count.
 */
export const brandStorePattern = (brand: string) => {
  // Case variants are built before escaping: upper-casing an escaped "\s+" would turn it into "\S+".
  const titleCase = brand.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
  const spellings = [...new Set([brand, brand.toUpperCase(), titleCase])].map(escapeRegex).join("|");
  return new RegExp(`\\b(${spellings})\\s+(of|OF)\\s+(?!(North\\s+)?America\\b|Canada\\b|the\\s+Year\\b)[A-Z]`);
};
/** Sponsored venues and events that carry the brand name ("BMW Championship", "Subaru Park"). */
export const brandSponsorshipPattern = (brand: string) =>
  new RegExp(`\\b${escapeRegex(brand)}\\s+(championship|open|pga|masters|international|classic|park|arena|center|centre|stadium|field|amphitheat(er|re))\\b`, "i");
/** Crime and police stories where a car of the brand is incidental. Recalls are exempt: "crash risk" is recall language. */
export const INCIDENTAL_CRIME_PATTERN =
  /\b(stole|stolen|steal(s|ing)?|theft|thie(f|ves)|arrest(s|ed)?|police|cops|deputies|accused|charged|suspect|murder|stabbing|shooting|shot|carjack\w*|pursuit|burglar\w*|robbery|killed|fatal)\b/i;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
}
export const NEAR_DUPLICATE_DAYS = 14;

/**
 * Brand-level stories (matched only on the brand, not on the dealership, group,
 * city or a custom keyword) are context, not dealership news: keep at most this
 * many new ones per news check so they don't drown out dealership-specific items.
 */
export const MAX_BRAND_ONLY_PER_SCAN = 8;

export const MAX_QUERIES_PER_DEALERSHIP = 8;
export const MAX_ARTICLES_PER_QUERY = 30;
/** Titles seen within this many days are treated as duplicates (syndicated stories). */
export const TITLE_DEDUPE_DAYS = 45;
