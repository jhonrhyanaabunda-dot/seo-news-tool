/**
 * Fill in exact publication times and descriptions for stored news articles
 * from the publishers' own pages and news sitemaps (robots.txt respected; Google
 * News links are never followed). News checks do this automatically for new articles.
 *   npm run news:enrich
 */
import "./load-env";
import { enrichArticles } from "@/lib/news/enrich";

async function main() {
  let total = { attempted: 0, timesFound: 0, summariesFound: 0, linksFound: 0 };
  for (;;) {
    const r = await enrichArticles({ limit: 25 });
    total = { attempted: total.attempted + r.attempted, timesFound: total.timesFound + r.timesFound, summariesFound: total.summariesFound + r.summariesFound, linksFound: total.linksFound + r.linksFound };
    if (r.attempted === 0) break;
  }
  console.log(`Article pages read: ${total.attempted} · exact times found: ${total.timesFound} · summaries found: ${total.summariesFound} · direct article links found: ${total.linksFound}`);
  process.exit(0);
}
main();
