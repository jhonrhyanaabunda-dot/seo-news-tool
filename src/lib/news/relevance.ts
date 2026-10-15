import {
  EXCLUDE_PATTERNS,
  INCIDENTAL_CRIME_PATTERN,
  KEYWORD_WEIGHTS,
  LOCAL_CONTEXT_PATTERN,
  NEAR_DUPLICATE_SHARED_FIGURE_WORDS,
  NEAR_DUPLICATE_THRESHOLD,
  OTHER_DEALER_PATTERN,
  TOPIC_RULES,
  brandSponsorshipPattern,
  brandStorePattern,
} from "./config";

export interface RelevanceKeyword {
  keyword: string;
  kind: keyof typeof KEYWORD_WEIGHTS;
}

function phraseRegex(phrase: string): RegExp {
  const escaped = phrase
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\s+/g, "\\s+");
  return new RegExp(`(^|[^a-z0-9])${escaped}($|[^a-z0-9])`, "i");
}

/**
 * "dealership" — about this store: its name, group, a custom keyword, or local
 * dealership news. Counted on the dashboard and eligible for alerts.
 * "brand" — manufacturer-level context (recalls, new models) matched on the
 * brand alone. Kept for reference but never counted as the dealership's news.
 */
export type NewsScope = "dealership" | "brand";

export interface ArticleScore {
  score: number;
  matched: string[];
  topics: string[];
  scope: NewsScope;
}

const noMatch = (): ArticleScore => ({ score: 0, matched: [], topics: [], scope: "brand" });

/** Deterministic relevance score (0-100), its scope, and the reasons that produced it. A score of 0 means "don't keep". */
export function scoreArticle(text: string, keywords: RelevanceKeyword[]): ArticleScore {
  if (EXCLUDE_PATTERNS.some((p) => p.test(text))) return noMatch();
  // A city name alone is too broad ("Charlotte man arrested…"): it only counts alongside dealership context.
  const localCounts = LOCAL_CONTEXT_PATTERN.test(text);
  let score = 0;
  const matched: string[] = [];
  const kindsHit = new Set<string>();
  for (const k of keywords) {
    if (!k.keyword.trim()) continue;
    if (k.kind === "local" && !localCounts) continue;
    if (phraseRegex(k.keyword).test(text)) {
      matched.push(k.keyword);
      // Each keyword kind counts once (two brand keywords don't double the score).
      if (!kindsHit.has(k.kind)) {
        kindsHit.add(k.kind);
        score += KEYWORD_WEIGHTS[k.kind];
      }
    }
  }
  if (!matched.length) return noMatch();

  const topics: string[] = [];
  let topicScore = 0;
  for (const rule of TOPIC_RULES) {
    if (rule.pattern.test(text)) {
      topics.push(rule.key);
      topicScore = Math.max(topicScore, rule.weight);
    }
  }

  // A city + "dealership" match is local dealership news — unless the article names another car
  // make, in which case it is a different store's news ("Findlay Kia Las Vegas" for a Las Vegas
  // Subaru dealership). With this brand named it is brand context; without it, not kept.
  const storeHit = kindsHit.has("dealership") || kindsHit.has("group") || kindsHit.has("custom");
  if (!storeHit && kindsHit.has("local")) {
    const ownBrands = keywords.filter((k) => k.kind === "brand").map((k) => k.keyword);
    if (namesOtherMake(text, ownBrands)) {
      kindsHit.delete("local");
      score -= KEYWORD_WEIGHTS.local;
      if (!kindsHit.has("brand")) return noMatch();
    }
  }
  const scope: NewsScope = [...kindsHit].some((k) => k !== "brand") ? "dealership" : "brand";
  if (scope === "brand") {
    const brands = keywords.filter((k) => k.kind === "brand" && k.keyword.trim()).map((k) => k.keyword);
    if (isNotManufacturerNews(text, brands, topics)) return noMatch();
    // Brand context is for U.S. dealerships: another market's recall or launch is not theirs.
    if (isForeignMarketStory(text)) return noMatch();
  }
  return { score: Math.min(100, score + topicScore), matched, topics, scope };
}

/** A brand-only match that is really another store's news, or the brand name in unrelated news. */
function isNotManufacturerNews(text: string, brands: string[], topics: string[]): boolean {
  if (OTHER_DEALER_PATTERN.test(text)) return true;
  // Donations, sponsorships and school events at brand level are some other store's community work.
  if (topics.includes("community")) return true;
  if (brands.some((b) => brandStorePattern(b).test(text) || brandSponsorshipPattern(b).test(text))) return true;
  return !topics.includes("recall") && INCIDENTAL_CRIME_PATTERN.test(text);
}

/** Normalise a headline for duplicate detection across sources. */
export function normalizeTitle(title: string, source?: string | null): string {
  let t = title;
  if (source) {
    const suffix = ` - ${source}`;
    if (t.endsWith(suffix)) t = t.slice(0, -suffix.length);
  }
  t = t.replace(/\s[-|–—]\s[^-|–—]{2,60}$/, ""); // trailing " - Publisher"
  return t
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOPWORDS = new Set(
  (
    "the and for with from over after into about amid than that this what why how who its are was were has have had will can could would may might " +
    "new says said report reports update news more most just all out off one two nearly almost some see here due lead leads " +
    "car cars vehicle vehicles model models"
  ).split(" "),
);

/** "149,000", "148,663" and "149K" all become "150k" so differently-worded copies of a story still match. */
function magnitude(raw: string): string | null {
  const m = /^(\d+(?:\.\d+)?)(k|m)?$/.exec(raw);
  if (!m) return null;
  let n = Number(m[1]) * (m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1);
  if (n < 1000) return raw.length === 4 && n >= 1900 && n <= 2100 ? raw : null; // keep years, drop small numbers
  const digits = Math.floor(Math.log10(n)) + 1;
  const unit = 10 ** Math.max(0, digits - 2);
  n = Math.round(n / unit) * unit;
  return n >= 1_000_000 ? `${Math.round(n / 100_000) / 10}m` : `${Math.round(n / 1000)}k`;
}

/** Significant, lightly-stemmed words of a normalised headline (for near-duplicate detection). */
export function titleTokens(normalized: string): Set<string> {
  const out = new Set<string>();
  // Re-join digit groups split by punctuation removal ("149 000" → "149000").
  const words = normalized.replace(/\b(\d{1,3})((?: \d{3})+)\b/g, (_m, a: string, b: string) => a + b.replace(/ /g, "")).split(" ");
  for (const raw of words) {
    if (/^\d/.test(raw)) {
      const mag = magnitude(raw);
      if (mag) out.add(mag);
      continue;
    }
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(raw.length > 4 ? raw.replace(/(ing|ed|es|s)$/, "") : raw);
  }
  return out;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Same story? Word overlap, with a lower bar when both headlines cite the same large figure. */
export function isNearDuplicate(a: Set<string>, b: Set<string>): boolean {
  if (jaccard(a, b) >= NEAR_DUPLICATE_THRESHOLD) return true;
  // Same large figure ("27,720 vehicles") plus at least two other shared words (e.g. brand + "recall").
  let sharedFigure = false;
  let sharedWords = 0;
  for (const t of a) {
    if (!b.has(t)) continue;
    if (/^\d+(\.\d+)?[km]$/.test(t)) sharedFigure = true;
    else sharedWords++;
  }
  return sharedFigure && sharedWords >= NEAR_DUPLICATE_SHARED_FIGURE_WORDS;
}

/** Topic tags for any text, independent of keyword matching. */
export function topicsFor(text: string): string[] {
  return TOPIC_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.key);
}

export function topicLabel(key: string): string {
  return TOPIC_RULES.find((r) => r.key === key)?.label ?? key;
}

/**
 * A brand story about another country's market: recalls and launches there do not
 * apply to a U.S. dealership. Matched on the headline/summary wording; the publisher's
 * own domain is checked separately (isForeignPublisher), since many such stories are
 * syndicated under neutral headlines.
 */
const FOREIGN_MARKET_PATTERN =
  /\b(in SA|South Africa|South African|Australia|Australian|New Zealand|in NZ|in the UK|U\.K\.|United Kingdom|Britain|British|in India|Indian market|Malaysia|Philippines|Singapore|Ireland|Irish|in Canada|Canadian)\b/i;

export function isForeignMarketStory(text: string): boolean {
  return FOREIGN_MARKET_PATTERN.test(text);
}

/** Publisher hosts on another country's domain (caradvice.com.au, iol.co.za, autocar.co.uk …). */
const FOREIGN_TLD = /\.(au|za|uk|nz|in|ie|sg|my|ph|ca)$/i;

export function isForeignPublisher(...urls: Array<string | null | undefined>): boolean {
  return urls.some((u) => {
    if (!u) return false;
    try {
      return FOREIGN_TLD.test(new URL(u).hostname);
    } catch {
      return false;
    }
  });
}

/** Car makes sold in the U.S., capitalised as headlines write them (so "ram" or "mini" in prose do not match). */
const MAKES = [
  "Acura", "Alfa Romeo", "Aston Martin", "Audi", "Bentley", "BMW", "Buick", "Cadillac", "Chevrolet", "Chevy", "Chrysler", "Dodge",
  "Ferrari", "Fiat", "Ford", "Genesis", "GMC", "Honda", "Hyundai", "Infiniti", "INFINITI", "Jaguar", "Jeep", "Kia", "Lamborghini",
  "Land Rover", "Lexus", "Lincoln", "Lucid", "Maserati", "Mazda", "McLaren", "Mercedes", "Mercedes-Benz", "MINI", "Mitsubishi",
  "Nissan", "Polestar", "Porsche", "Ram", "Rivian", "Rolls-Royce", "Subaru", "Tesla", "Toyota", "Volkswagen", "VW", "Volvo",
];

/** Whether the text names a car make other than the dealership's own brand(s). */
export function namesOtherMake(text: string, ownBrands: string[]): boolean {
  const own = ownBrands.map((b) => b.toLowerCase().replace(/[\s-]+/g, ""));
  const isOwn = (make: string) => {
    const m = make.toLowerCase().replace(/[\s-]+/g, "");
    return own.some((o) => o === m || o.startsWith(m) || m.startsWith(o));
  };
  return MAKES.some((make) => !isOwn(make) && new RegExp(`(^|[^A-Za-z])${make.replace(/[-\s]/g, "[-\s]?")}($|[^A-Za-z])`).test(text));
}
