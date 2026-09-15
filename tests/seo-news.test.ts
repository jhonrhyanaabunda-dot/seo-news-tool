import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySeoArticle, cleanSeoSummary, cleanSeoTitle, pickTopStories } from "@/lib/news/seo-topics";
import { renderDigestEmail } from "@/lib/email/templates";

test("SEO articles are tagged by topic, with headline matches and official sources weighing more", () => {
  const update = classifySeoArticle("Google releases the September 2026 core update", "Rollout will take two weeks.", 1);
  assert.deepEqual(update.topics, ["google_update"]);
  assert.equal(update.importance, 40 + 25);

  const local = classifySeoArticle("How car dealerships can win the local pack", "Google Business Profile tips and AI Overviews.", 3);
  assert.ok(local.topics.includes("automotive"));
  assert.ok(local.topics.includes("local_seo"));
  assert.ok(local.topics.includes("ai_search"));
  // automotive + local in the headline count fully; AI search only in the summary counts half.
  assert.equal(local.importance, 30 + 30 + 10);

  const plain = classifySeoArticle("Our favourite marketing podcasts", null, 3);
  assert.deepEqual(plain.topics, []);
  assert.equal(plain.importance, 0);

  assert.ok(classifySeoArticle("A", "core update ".repeat(3) + "car dealership local seo ai overviews search console core web vitals", 1).importance <= 100);
});

test("top stories rank by importance, then recency, with at most three per publication", () => {
  const at = (day: number) => new Date(`2026-09-${String(day).padStart(2, "0")}T12:00:00Z`);
  const articles = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: i + 1, source: "Search Engine Roundtable", importance: 50, publishedAt: at(10 + i), detectedAt: at(10 + i) })),
    { id: 10, source: "Google Search Central Blog", importance: 65, publishedAt: at(9), detectedAt: at(9) },
    { id: 11, source: "Moz Blog", importance: 0, publishedAt: at(14), detectedAt: at(14) },
    { id: 12, source: "Ahrefs Blog", importance: 0, publishedAt: null, detectedAt: at(15) },
  ];
  const top = pickTopStories(articles, 5);
  assert.deepEqual(
    top.map((a) => a.id),
    [10, 5, 4, 3, 12],
  );
});

test("weekly newsletter leads with SEO stories and is sent even without dealership changes", () => {
  const r = renderDigestEmail({
    kind: "weekly",
    periodLabel: "Week of Sep 8, 2026 to Sep 15, 2026",
    dashboardUrl: "https://app",
    timeZone: "America/Chicago",
    dealers: [],
    seoStories: [
      { title: "Google <core> update", url: "https://example.com/a?x=1&y=2", source: "Search Engine Land", summary: "Big changes.", publishedAt: new Date("2026-09-12T15:00:00Z"), topics: ["google_update"] },
    ],
  });
  assert.equal(r.subject, "Weekly SEO Newsletter — 1 top SEO story");
  assert.match(r.text, /THIS WEEK IN SEO/);
  assert.match(r.text, /Search Engine Land · Sep 12 · Google update/);
  assert.match(r.text, /All SEO news: https:\/\/app\/seo-news/);
  assert.ok(r.html.includes("Google &lt;core&gt; update"), "headline is HTML-escaped");
  assert.ok(r.html.includes("https://example.com/a?x=1&amp;y=2"), "link is attribute-escaped");
  assert.ok(r.html.includes("weekly newsletter"), "newsletter footer");
  assert.ok(!r.html.includes("only sent when something meaningful changes"));
});

test("daily digest is unchanged by the newsletter", () => {
  const r = renderDigestEmail({ kind: "daily", periodLabel: "Changes in the last 24 hours", dashboardUrl: "https://app", dealers: [], seoStories: [{ title: "x", url: "https://x", source: "y", summary: null, publishedAt: null, topics: [] }] });
  assert.equal(r.subject, "Daily SEO & News Monitoring Report — no changes");
  assert.doesNotMatch(r.text, /THIS WEEK IN SEO/);
});

test("publisher boilerplate is removed from headlines and promotions don't lead the newsletter", () => {
  assert.equal(cleanSeoTitle("Google Tests Paying Publishers For AI Answers via @sejournal, @MattGSouthern"), "Google Tests Paying Publishers For AI Answers");
  assert.equal(cleanSeoTitle("Google core update via @sejournal"), "Google core update");
  assert.equal(cleanSeoTitle("How to reach customers via email"), "How to reach customers via email");
  const promo = classifySeoArticle("Is Your Local SEO Strategy Ready? [Webinar]", null, 2);
  const story = classifySeoArticle("Google Business Profile adds new review filters", null, 2);
  assert.ok(promo.topics.includes("local_seo"));
  assert.ok(promo.importance < story.importance);
});

test("WordPress 'The post … appeared first on' footers are removed from summaries", () => {
  assert.equal(cleanSeoSummary("Give ChatGPT Ads a clear role. The post ChatGPT Ads Aren’t Paid Search – 5 Questions To Answer Before You Shift…", "ChatGPT Ads Aren’t Paid Search – 5 Questions"), "Give ChatGPT Ads a clear role.");
  assert.equal(cleanSeoSummary("Plain summary.", "Title"), "Plain summary.");
  assert.equal(cleanSeoSummary("The post Title appeared first on Site.", "Title"), null);
});
