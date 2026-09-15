/**
 * Keeping report text truthful. Pure functions.
 *
 *  - groundNarrative(): accepts the model's output only where it points at real
 *    findings. Actions for unknown checks, highlights for unknown articles and
 *    text quoting numbers that appear nowhere in the findings are discarded
 *    (replaced by deterministic wording), and priority/affected-page counts are
 *    always taken from the findings, never from the model.
 *  - deterministicNarrative(): the same report without a model — used when no
 *    API key is configured, the monthly limit is reached, or the model declines.
 */
import { PRIORITY_ORDER, REPORT_GROUPS } from "@/lib/seo/priority";
import type { AiNarrative, ReportAction, ReportFindings, ReportNarrative } from "./types";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Fields whose digits are not facts a sentence could quote (timestamps, addresses). */
const NON_FACT_KEYS = new Set(["completedAt", "publishedAt", "url", "websiteUrl", "sampleUrls", "items"]);

/**
 * Every number a report may quote: numeric values in the findings (scores,
 * counts, deltas) and numbers inside fact text such as issue examples
 * ("1 of 10 images…"). Dates and URLs are excluded — otherwise a timestamp like
 * 2026-09-14T07:30 would make an invented "14 broken links" look grounded.
 */
export function findingNumbers(findings: ReportFindings): Set<number> {
  const out = new Set<number>([100]); // scores are quoted "out of 100"
  const visit = (value: unknown, key: string) => {
    if (NON_FACT_KEYS.has(key)) return;
    if (typeof value === "number") out.add(Math.abs(value));
    else if (typeof value === "string") for (const m of value.matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
    else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
    else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) visit(v, k);
  };
  visit(findings, "");
  return out;
}

/**
 * Numbers in `text` that the findings do not contain. Years and ordinal list
 * positions ("top 3") up to `smallOk` are allowed.
 */
export function ungroundedNumbers(text: string, allowed: Set<number>, smallOk = 0): number[] {
  const bad: number[] = [];
  // Strip digits that are part of URLs, model names or words like "H1"/"404s" handled via allowed set.
  const cleaned = text.replace(/https?:\/\/\S+/g, " ").replace(/\b[a-z]+\d+[a-z0-9]*\b/gi, " ");
  for (const m of cleaned.matchAll(/(?<![\w.])\d{1,3}(?:,\d{3})*(?:\.\d+)?(?![\w])/g)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (allowed.has(n) || (n >= 1900 && n <= 2100) || n <= smallOk) continue;
    bad.push(n);
  }
  return bad;
}

function sortActions(actions: ReportAction[]): ReportAction[] {
  // Stable: equal priority keeps the model's (or the findings') order.
  return actions
    .map((a, i) => ({ a, i }))
    .sort((x, y) => PRIORITY_ORDER[x.a.priority] - PRIORITY_ORDER[y.a.priority] || x.i - y.i)
    .map((x) => x.a);
}

export function groundNarrative(ai: AiNarrative, findings: ReportFindings): ReportNarrative {
  const discarded: string[] = [];
  const allowed = findingNumbers(findings);
  const issueByKey = new Map(findings.issues.map((i) => [i.checkKey, i]));
  const articleIds = new Set([...findings.news.dealership, ...findings.news.manufacturer, ...findings.news.industry].map((a) => a.id));
  const fallback = deterministicNarrative(findings);
  const truthful = (field: string, text: string, smallOk = 0): boolean => {
    const bad = ungroundedNumbers(text, allowed, smallOk);
    if (bad.length) discarded.push(`${field}: numbers not in the findings (${bad.join(", ")})`);
    return bad.length === 0;
  };

  const seen = new Set<string>();
  const actions: ReportAction[] = [];
  for (const a of ai.recommendedActions) {
    const issue = issueByKey.get(a.checkKey);
    if (!issue) {
      discarded.push(`action for unknown check "${a.checkKey}"`);
      continue;
    }
    if (seen.has(a.checkKey)) continue;
    if (!truthful(`action ${a.checkKey}`, `${a.action} ${a.rationale}`)) continue;
    seen.add(a.checkKey);
    actions.push({ checkKey: issue.checkKey, title: issue.title, priority: issue.priority, affectedPages: issue.affectedPages, unit: issue.unit, action: a.action.trim(), rationale: a.rationale.trim() });
  }
  // Every CRITICAL/HIGH finding gets an action even if the model skipped it.
  for (const f of fallback.recommendedActions) {
    if (!seen.has(f.checkKey) && (f.priority === "CRITICAL" || f.priority === "HIGH")) actions.push(f);
  }

  const summaryOk = ai.executiveSummary.trim().length > 0 && truthful("executive summary", ai.executiveSummary, 3);
  const protectedOk = findings.protectedPages.total > 0 && ai.protectedPagesNote !== null && truthful("protected pages note", ai.protectedPagesNote);
  const hasNews = articleIds.size > 0;
  const newsOk = hasNews && ai.newsSummary !== null && truthful("news summary", ai.newsSummary);

  const highlights = ai.newsHighlights.filter((h) => {
    if (articleIds.has(h.articleId)) return true;
    discarded.push(`highlight for unknown article ${h.articleId}`);
    return false;
  });

  return {
    executiveSummary: summaryOk ? ai.executiveSummary.trim() : fallback.executiveSummary,
    recommendedActions: sortActions(actions),
    protectedPagesNote: findings.protectedPages.total > 0 ? (protectedOk ? ai.protectedPagesNote!.trim() : fallback.protectedPagesNote) : null,
    newsSummary: hasNews ? (newsOk ? ai.newsSummary!.trim() : fallback.newsSummary) : null,
    newsHighlights: highlights.map((h) => ({ articleId: h.articleId, note: h.note.trim() })),
    discarded,
  };
}

export function deterministicNarrative(f: ReportFindings): ReportNarrative {
  const s = f.scan;
  const parts: string[] = [];
  if (s.score === null) {
    parts.push(
      s.siteAvailable === false
        ? `${f.dealership.name}'s website could not be loaded during the latest scan, so no SEO score was calculated.`
        : `${f.dealership.name}'s website restricted automated access during the latest scan, so no SEO score was calculated.`,
    );
  } else {
    const band = s.score >= 85 ? "good" : s.score >= 65 ? "needs improvement" : "poor";
    parts.push(`${f.dealership.name} scored ${s.score}/100 (${band}) across ${plural(s.pagesAnalyzed, "analyzed page")}.`);
  }
  const serious = f.counts.critical + f.counts.high;
  if (f.counts.critical) parts.push(`${plural(f.counts.critical, "critical issue")} ${f.counts.critical === 1 ? "needs" : "need"} immediate attention.`);
  else if (serious) parts.push(`No critical issues were found; ${plural(f.counts.high, "high-priority issue")} should be addressed next.`);
  else if (f.issues.length) parts.push("No critical or high-priority issues were found.");
  if (s.pagesProtected) parts.push(`${plural(s.pagesProtected, "page")} could not be analyzed because the website restricted automated access; these are not counted as SEO problems.`);

  const actions = f.issues.map<ReportAction>((i) => ({
    checkKey: i.checkKey,
    title: i.title,
    priority: i.priority,
    affectedPages: i.affectedPages,
    unit: i.unit,
    action: i.recommendation,
    rationale: i.unit === "link" ? `${REPORT_GROUPS[i.group]} issue: ${plural(i.affectedPages, "broken link")}.` : `${REPORT_GROUPS[i.group]} issue affecting ${plural(i.affectedPages, "page")}.`,
  }));

  const newsTotal = f.news.dealership.length + f.news.manufacturer.length + f.news.industry.length;
  return {
    executiveSummary: parts.join(" "),
    recommendedActions: sortActions(actions),
    protectedPagesNote: f.protectedPages.total
      ? `${plural(f.protectedPages.total, "page")} returned a security challenge or refusal instead of content. Ask the website provider to allow-list the A3SEOMonitor crawler to include them in future reports.`
      : null,
    newsSummary: newsTotal
      ? `${plural(f.news.dealership.length, "dealership news item")}, ${plural(f.news.manufacturer.length, "manufacturer update")} and ${plural(f.news.industry.length, "industry item")} in the last ${f.news.periodDays} days.`
      : null,
    newsHighlights: [],
    discarded: [],
  };
}
