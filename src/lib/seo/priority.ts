/**
 * Report priority levels (CRITICAL / HIGH / MEDIUM / LOW / PASS) and report
 * groupings for every SEO check.
 *
 * Stored issue severities stay critical / warning / info: issue fingerprints,
 * change detection, alerts and scoring all key on them. Priority is a
 * presentation layer on top, defined per check here so it is reviewable and
 * consistent with severity (a unit test enforces that): critical → CRITICAL,
 * warning → HIGH or MEDIUM, info → LOW.
 */
import { CHECKS, type Severity } from "./checks/config";

export type ReportPriority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "PASS";
export type IssuePriority = Exclude<ReportPriority, "PASS">;

export const CHECK_PRIORITY: Record<string, IssuePriority> = {
  // Search visibility is broken or the page cannot be used.
  site_unavailable: "CRITICAL",
  http_error: "CRITICAL",
  not_https: "CRITICAL",
  title_missing: "CRITICAL",
  robots_blocks_all: "CRITICAL",
  noindex_important: "CRITICAL",
  // Directly affects rankings, indexing or conversions on important pages.
  broken_internal_link: "HIGH",
  canonical_mismatch: "HIGH",
  client_redirect: "HIGH",
  description_missing: "HIGH",
  dealer_schema_missing: "HIGH",
  h1_missing: "HIGH",
  image_alt_missing: "HIGH",
  important_page_missing: "HIGH",
  sitemap_missing: "HIGH",
  slow_response: "HIGH",
  title_duplicate: "HIGH",
  viewport_missing: "HIGH",
  // Worth fixing; limited or indirect impact.
  canonical_missing: "MEDIUM",
  description_duplicate: "MEDIUM",
  large_html: "MEDIUM",
  mixed_content: "MEDIUM",
  robots_missing: "MEDIUM",
  schema_invalid: "MEDIUM",
  schema_missing: "MEDIUM",
  sitemap_empty: "MEDIUM",
  thin_content: "MEDIUM",
  title_length: "MEDIUM",
  // Best-practice refinements.
  blocking_scripts: "LOW",
  broken_external_link: "LOW",
  description_length: "LOW",
  h1_multiple: "LOW",
  h2_missing: "LOW",
  image_dimensions_missing: "LOW",
  lang_missing: "LOW",
  low_internal_links: "LOW",
  noindex_page: "LOW",
  og_missing: "LOW",
  sitemap_not_in_robots: "LOW",
};

export const PRIORITY_ORDER: Record<ReportPriority, number> = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, PASS: 4 };

/** Priority for a check key, falling back to its stored severity for any check added later without a mapping. */
export function priorityFor(checkKey: string, severity?: Severity): IssuePriority {
  const mapped = CHECK_PRIORITY[checkKey];
  if (mapped) return mapped;
  const sev = severity ?? CHECKS.find((c) => c.key === checkKey)?.severity ?? "info";
  return sev === "critical" ? "CRITICAL" : sev === "warning" ? "MEDIUM" : "LOW";
}

export type ReportGroup = "technical" | "on_page" | "indexing" | "metadata" | "internal_linking" | "images" | "structured_data" | "performance";

export const REPORT_GROUPS: Record<ReportGroup, string> = {
  technical: "Technical SEO",
  on_page: "On-page SEO",
  indexing: "Indexing",
  metadata: "Metadata",
  internal_linking: "Internal linking",
  images: "Images",
  structured_data: "Structured data",
  performance: "Performance",
};

const GROUP_BY_CHECK: Record<string, ReportGroup> = {
  site_unavailable: "technical",
  http_error: "technical",
  not_https: "technical",
  mixed_content: "technical",
  viewport_missing: "technical",
  lang_missing: "technical",
  client_redirect: "technical",
  slow_response: "performance",
  large_html: "performance",
  blocking_scripts: "performance",
  title_missing: "metadata",
  title_length: "metadata",
  title_duplicate: "metadata",
  description_missing: "metadata",
  description_length: "metadata",
  description_duplicate: "metadata",
  og_missing: "metadata",
  canonical_missing: "indexing",
  canonical_mismatch: "indexing",
  robots_missing: "indexing",
  robots_blocks_all: "indexing",
  sitemap_missing: "indexing",
  sitemap_not_in_robots: "indexing",
  sitemap_empty: "indexing",
  noindex_important: "indexing",
  noindex_page: "indexing",
  h1_missing: "on_page",
  h1_multiple: "on_page",
  h2_missing: "on_page",
  thin_content: "on_page",
  broken_internal_link: "internal_linking",
  broken_external_link: "internal_linking",
  low_internal_links: "internal_linking",
  important_page_missing: "internal_linking",
  image_alt_missing: "images",
  image_dimensions_missing: "images",
  schema_missing: "structured_data",
  schema_invalid: "structured_data",
  dealer_schema_missing: "structured_data",
};

export function reportGroupFor(checkKey: string): ReportGroup {
  return GROUP_BY_CHECK[checkKey] ?? "technical";
}
