import type { Dealership, NewsKeyword } from "@/lib/db/schema";
import { MAX_QUERIES_PER_DEALERSHIP } from "./config";
import type { RelevanceKeyword } from "./relevance";

export interface NewsQuery {
  query: string;
  purpose: string;
}

const q = (s: string) => `"${s.replace(/"/g, "")}"`;

/** A web address is not a name: searching or matching on it finds nothing and wastes a query. */
export function looksLikeUrl(s: string): boolean {
  return /^\s*(https?:\/\/|www\.)|\.[a-z]{2,}(\/|$)/i.test(s.trim());
}

/**
 * Build a bounded, deterministic set of search queries for a dealership.
 * Covers: dealership name, dealer group, custom keywords, brand recalls,
 * new models / manufacturer news, and local automotive news.
 */
export function buildQueries(d: Dealership, keywords: NewsKeyword[]): NewsQuery[] {
  const out: NewsQuery[] = [];
  const enabled = keywords.filter((k) => k.isEnabled);
  out.push({ query: q(d.name), purpose: "Dealership mentions" });
  if (d.dealerGroup && !looksLikeUrl(d.dealerGroup)) out.push({ query: q(d.dealerGroup), purpose: "Dealer group news" });
  for (const k of enabled.filter((k) => k.kind === "custom").slice(0, 3)) out.push({ query: q(k.keyword), purpose: "Custom keyword" });
  out.push({ query: `${d.brand} recall`, purpose: "Recalls" });
  out.push({ query: `${d.brand} (unveils OR debut OR "all-new" OR "new model")`, purpose: "New vehicle models" });
  out.push({ query: `${d.brand} (announces OR award OR dealership)`, purpose: "Manufacturer announcements & awards" });
  if (d.city) out.push({ query: `${d.brand} dealership ${d.city}${d.state ? ` ${d.state}` : ""}`, purpose: "Local automotive news" });
  if (d.city) out.push({ query: `"${d.city}" car dealership`, purpose: "Local dealership news" });
  // De-duplicate and cap.
  const seen = new Set<string>();
  return out.filter((x) => (seen.has(x.query.toLowerCase()) ? false : (seen.add(x.query.toLowerCase()), true))).slice(0, MAX_QUERIES_PER_DEALERSHIP);
}

/** Entities an article can match for relevance scoring. */
export function relevanceKeywords(d: Dealership, keywords: NewsKeyword[]): RelevanceKeyword[] {
  const list: RelevanceKeyword[] = [{ keyword: d.name, kind: "dealership" }];
  if (d.dealerGroup && !looksLikeUrl(d.dealerGroup)) list.push({ keyword: d.dealerGroup, kind: "group" });
  list.push({ keyword: d.brand, kind: "brand" });
  if (d.city) list.push({ keyword: d.city, kind: "local" });
  for (const k of keywords) {
    if (!k.isEnabled || looksLikeUrl(k.keyword)) continue;
    const kind = k.kind === "dealership" || k.kind === "group" || k.kind === "brand" || k.kind === "local" ? k.kind : "custom";
    if (!list.some((x) => x.keyword.toLowerCase() === k.keyword.toLowerCase())) list.push({ keyword: k.keyword, kind });
  }
  return list;
}
