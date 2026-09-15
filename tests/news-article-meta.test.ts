import { test } from "node:test";
import assert from "node:assert/strict";
import { extractArticleMeta, pageTimeMatchesFeed, publishedPrecision } from "@/lib/news/article-meta";
import { fmtPublished } from "@/components/format";

test("Google News date-only placeholders and midnight UTC are dates, not times", () => {
  assert.equal(publishedPrecision("google_rss", new Date("2026-08-21T07:00:00Z")), "date");
  assert.equal(publishedPrecision("google_rss", new Date("2026-01-21T08:00:00Z")), "date");
  assert.equal(publishedPrecision("rss", new Date("2026-08-21T00:00:00Z")), "date");
  assert.equal(publishedPrecision("google_rss", new Date("2026-09-14T10:51:03Z")), "datetime");
  assert.equal(publishedPrecision("bing_rss", new Date("2026-08-21T07:00:00Z")), "datetime");
  assert.equal(publishedPrecision("google_rss", null), null);
});

test("publication time comes from the page's JSON-LD or meta tags, never a date without a time", () => {
  const html = `<html><head>
    <meta property="og:description" content="A local dealership donated $15,000 to an elementary school to support teachers this fall.">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebSite"},{"@type":"NewsArticle","datePublished":"2026-08-19T16:42:00-07:00"}]}</script>
  </head><body></body></html>`;
  const meta = extractArticleMeta(html, "Subaru of Las Vegas surprises teachers");
  assert.equal(meta.publishedAt?.toISOString(), "2026-08-19T23:42:00.000Z");
  assert.match(meta.description ?? "", /donated \$15,000/);

  const dateOnly = extractArticleMeta(`<meta property="article:published_time" content="2026-08-19"><meta name="description" content="Short">`, "Title");
  assert.equal(dateOnly.publishedAt, null, "a date without a time is not an exact publication time");
  assert.equal(dateOnly.description, null, "descriptions too short to summarise are ignored");

  const metaTag = extractArticleMeta(`<meta property="article:published_time" content="2026-08-21T14:05:00Z">`, "Title");
  assert.equal(metaTag.publishedAt?.toISOString(), "2026-08-21T14:05:00.000Z");
});

test("a page time far from the feed's date is not trusted", () => {
  const feed = new Date("2026-08-21T07:00:00Z");
  assert.equal(pageTimeMatchesFeed(new Date("2026-08-21T19:30:00Z"), feed), true);
  assert.equal(pageTimeMatchesFeed(new Date("2026-08-25T10:00:00Z"), feed), false);
});

test("published dates keep the publisher's day and show a time only when one is known", () => {
  const dateOnly = fmtPublished(new Date("2026-08-21T00:00:00Z"), "date", "America/Chicago");
  assert.deepEqual(dateOnly, { date: "Fri, Aug 21, 2026", time: null });
  const exact = fmtPublished(new Date("2026-08-21T19:05:00Z"), "datetime", "America/Chicago");
  assert.equal(exact?.date, "Fri, Aug 21, 2026");
  assert.equal(exact?.time, "2:05 PM CDT");
});

test("a Google News headline is matched to the publisher's news sitemap entry", async () => {
  const { parseNewsSitemap, findInNewsSitemap } = await import("@/lib/news/article-meta");
  const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">
    <url><loc>https://www.wjhg.com/2026/08/21/man-arrested-alleged-burglary-car-theft-fort-walton-beach-dealership/</loc><news:news><news:publication><news:name>WJHG</news:name></news:publication><news:publication_date>2026-08-21T19:12:44.120Z</news:publication_date><news:title><![CDATA[Man arrested for alleged burglary, car theft at Fort Walton Beach dealership]]></news:title></news:news></url>
    <url><loc>https://www.wjhg.com/2026/08/21/other/</loc><news:news><news:publication_date>2026-08-21T10:00:00Z</news:publication_date><news:title>Rescued beagles find forever homes</news:title></news:news></url>
  </urlset>`;
  const { entries, children } = parseNewsSitemap(xml);
  assert.equal(entries.length, 2);
  assert.equal(children.length, 0);
  const match = findInNewsSitemap("Man arrested for alleged burglary, car theft at Fort Walton Beach dealership - WJHG", "WJHG", new Date("2026-08-21T07:00:00Z"), entries);
  assert.equal(match?.loc, "https://www.wjhg.com/2026/08/21/man-arrested-alleged-burglary-car-theft-fort-walton-beach-dealership/");
  assert.equal(match?.publishedAt.toISOString(), "2026-08-21T19:12:44.120Z");
  assert.equal(findInNewsSitemap("Dealership donates to school - WJHG", "WJHG", new Date("2026-08-21T07:00:00Z"), entries), null, "an unrelated headline never borrows another story's time");

  const index = parseNewsSitemap(`<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://www.wjhg.com/news-sitemap.xml</loc></sitemap></sitemapindex>`);
  assert.deepEqual(index.children, ["https://www.wjhg.com/news-sitemap.xml"]);
});
