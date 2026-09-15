/**
 * Report data contracts. Pure module (no database or network).
 *
 * ReportFindings  — facts from the crawler and database, computed by code.
 * AiNarrative     — what the model may add: wording and prioritisation only,
 *                   every item pointing back at a finding by key or id.
 * ReportNarrative — the grounded narrative actually shown and emailed.
 */
import { z } from "zod/v4";
import type { IssuePriority, ReportGroup } from "@/lib/seo/priority";
import type { PageResultClass } from "@/lib/db/schema";
import type { CrawlJobStatus } from "@/lib/jobs/status";

/** Bump when the findings shape or the prompt changes, so cached narratives are not reused across versions. */
export const REPORT_VERSION = 2;

export interface FindingIssue {
  checkKey: string;
  title: string;
  group: ReportGroup;
  priority: IssuePriority;
  /** Pages with the issue — or, for link checks, distinct broken links (see `unit`). */
  affectedPages: number;
  unit: "page" | "link";
  sampleUrls: string[];
  example: string;
  recommendation: string;
}

export interface FindingArticle {
  id: number;
  title: string;
  source: string | null;
  url: string;
  publishedAt: string | null;
  sourceType: string;
  scope: "dealership" | "brand";
  topics: string[];
  relevance: string;
}

export interface ReportFindings {
  version: number;
  dealership: { id: number; name: string; websiteUrl: string; brand: string; location: string | null; platform: string | null };
  scan: {
    id: number;
    completedAt: string | null;
    status: CrawlJobStatus;
    outcomeLabel: string;
    score: number | null;
    categoryScores: Array<{ category: string; label: string; score: number }>;
    pagesRequested: number;
    pagesAnalyzed: number;
    pagesProtected: number;
    siteAvailable: boolean | null;
    limitedHomepageCheckOnly: boolean;
  };
  counts: { critical: number; high: number; medium: number; low: number; passedChecks: number };
  issues: FindingIssue[];
  passedChecks: Array<{ checkKey: string; label: string; group: ReportGroup }>;
  protectedPages: { total: number; items: Array<{ url: string; resultClass: PageResultClass; reason: string | null }> };
  changes: { scoreDelta: number | null; newIssues: number; resolvedIssues: number } | null;
  performance: { mobileScore: number | null; lcpMs: number | null; cls: number | null } | null;
  news: {
    periodDays: number;
    newCount: number;
    relevantCount: number;
    dealership: FindingArticle[];
    manufacturer: FindingArticle[];
    industry: FindingArticle[];
  };
}

/** Structured output requested from the model. */
export const AiNarrativeSchema = z.object({
  executiveSummary: z.string().describe("2-4 sentences for a dealership manager: overall SEO health, the most important problems, and whether anything could not be analysed. Only facts present in the findings."),
  recommendedActions: z
    .array(
      z.object({
        checkKey: z.string().describe("Exactly one checkKey from findings.issues"),
        action: z.string().describe("What to change on the website, specific to this dealership's findings"),
        rationale: z.string().describe("Why it matters for search visibility or leads, in one or two sentences"),
      }),
    )
    .describe("Prioritised actions, most important first. Only issues present in findings.issues."),
  protectedPagesNote: z.string().nullable().describe("One sentence about pages that could not be analysed, or null when findings.protectedPages.total is 0"),
  newsSummary: z.string().nullable().describe("1-2 sentences summarising the news items, or null when there are none"),
  newsHighlights: z.array(z.object({ articleId: z.number().int(), note: z.string().describe("Why this article matters to the dealership") })),
});
export type AiNarrative = z.infer<typeof AiNarrativeSchema>;

export interface ReportAction {
  checkKey: string;
  title: string;
  priority: IssuePriority;
  affectedPages: number;
  unit: "page" | "link";
  action: string;
  rationale: string;
}

export interface ReportNarrative {
  executiveSummary: string;
  recommendedActions: ReportAction[];
  protectedPagesNote: string | null;
  newsSummary: string | null;
  newsHighlights: Array<{ articleId: number; note: string }>;
  /** Parts of the model output that were discarded because they did not match the findings. */
  discarded: string[];
}
