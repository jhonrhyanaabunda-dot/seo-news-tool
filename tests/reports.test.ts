import { test } from "node:test";
import assert from "node:assert/strict";
import { deterministicNarrative, groundNarrative, ungroundedNumbers, findingNumbers } from "@/lib/reports/ground";
import { AiNarrativeSchema, type ReportFindings } from "@/lib/reports/types";

function findings(over: Partial<ReportFindings> = {}): ReportFindings {
  return {
    version: 1,
    dealership: { id: 1, name: "BMW of Fort Walton Beach", websiteUrl: "https://www.bmwfwb.com/", brand: "BMW", location: "Fort Walton Beach, FL", platform: null },
    scan: { id: 58, completedAt: "2026-09-14T07:30:00.000Z", status: "COMPLETED", outcomeLabel: "Completed", score: 86, categoryScores: [{ category: "links", label: "Links", score: 38 }], pagesRequested: 30, pagesAnalyzed: 29, pagesProtected: 0, siteAvailable: true, limitedHomepageCheckOnly: false },
    counts: { critical: 0, high: 2, medium: 1, low: 0, passedChecks: 30 },
    issues: [
      { checkKey: "broken_internal_link", title: "Broken internal links", group: "internal_linking", priority: "HIGH", affectedPages: 29, unit: "link", sampleUrls: ["https://www.bmwfwb.com/"], example: "Broken link", recommendation: "Update or remove the broken link." },
      { checkKey: "h1_missing", title: "Missing H1 headings", group: "on_page", priority: "HIGH", affectedPages: 2, unit: "page", sampleUrls: [], example: "No H1", recommendation: "Add an H1." },
      { checkKey: "title_length", title: "Titles too short or too long", group: "metadata", priority: "MEDIUM", affectedPages: 12, unit: "page", sampleUrls: [], example: "Too long", recommendation: "Rewrite the title." },
    ],
    passedChecks: [],
    protectedPages: { total: 0, items: [] },
    changes: null,
    performance: null,
    news: { periodDays: 30, newCount: 0, relevantCount: 0, dealership: [], manufacturer: [], industry: [] },
    ...over,
  };
}

test("AI actions for issues that do not exist are discarded, and priorities come from the findings", () => {
  const f = findings();
  const out = groundNarrative(
    {
      executiveSummary: "BMW of Fort Walton Beach scored 86 out of 100 across 29 analyzed pages.",
      recommendedActions: [
        { checkKey: "title_length", action: "Shorten the long titles.", rationale: "Long titles get truncated." },
        { checkKey: "core_web_vitals_failing", action: "Fix LCP.", rationale: "Invented issue." },
        { checkKey: "broken_internal_link", action: "Fix the Show Specials link.", rationale: "It is on 29 pages." },
      ],
      protectedPagesNote: "Some pages were blocked.",
      newsSummary: "Big news!",
      newsHighlights: [{ articleId: 999, note: "Invented article" }],
    },
    f,
  );
  assert.deepEqual(out.recommendedActions.map((a) => a.checkKey), ["broken_internal_link", "h1_missing", "title_length"], "HIGH before MEDIUM; skipped HIGH finding still gets an action");
  assert.equal(out.recommendedActions[0].affectedPages, 29);
  assert.ok(out.discarded.some((d) => d.includes("core_web_vitals_failing")));
  assert.equal(out.protectedPagesNote, null, "no protected pages → no note, whatever the model said");
  assert.equal(out.newsSummary, null, "no news → no news summary");
  assert.deepEqual(out.newsHighlights, []);
  assert.equal(out.executiveSummary, "BMW of Fort Walton Beach scored 86 out of 100 across 29 analyzed pages.");
});

test("text quoting numbers that are not in the findings is replaced with deterministic wording", () => {
  const f = findings();
  const out = groundNarrative(
    { executiveSummary: "The site scored 92/100 with 14 broken links.", recommendedActions: [], protectedPagesNote: null, newsSummary: null, newsHighlights: [] },
    f,
  );
  assert.equal(out.executiveSummary, deterministicNarrative(f).executiveSummary);
  assert.ok(out.discarded.some((d) => d.includes("92") && d.includes("14")));
  assert.deepEqual(ungroundedNumbers("Scored 86/100 in 2026 on the X3 page", findingNumbers(f)), []);
});

test("the deterministic report states only what the findings contain", () => {
  const f = findings({ scan: { ...findings().scan, pagesProtected: 3 }, protectedPages: { total: 3, items: [] } });
  const n = deterministicNarrative(f);
  assert.match(n.executiveSummary, /scored 86\/100/);
  assert.match(n.executiveSummary, /3 pages could not be analyzed/);
  assert.equal(n.recommendedActions.length, 3);
  assert.ok(n.protectedPagesNote);
  assert.deepEqual(ungroundedNumbers(`${n.executiveSummary} ${n.protectedPagesNote}`, findingNumbers(f)), []);
  const blocked = deterministicNarrative(findings({ scan: { ...findings().scan, score: null, siteAvailable: true } }));
  assert.match(blocked.executiveSummary, /restricted automated access/);
});

test("the model output schema matches what the grounding step expects", () => {
  const ok = AiNarrativeSchema.safeParse({ executiveSummary: "x", recommendedActions: [{ checkKey: "h1_missing", action: "a", rationale: "r" }], protectedPagesNote: null, newsSummary: null, newsHighlights: [] });
  assert.ok(ok.success);
  assert.ok(!AiNarrativeSchema.safeParse({ executiveSummary: "x" }).success);
});
