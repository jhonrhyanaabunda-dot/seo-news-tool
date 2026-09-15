/**
 * Re-apply the current news relevance rules to articles already stored, so a
 * rule change fixes existing data rather than only future news checks.
 *
 *   npm run news:rescore            # dry run: report what would change
 *   npm run news:rescore -- --apply # write the changes
 *
 * For each article: recompute score, scope, matches and topics; delete unreviewed
 * articles the rules now reject; and delete unreviewed copies of a story already
 * kept. Articles a person has marked Relevant, Reviewed or Not relevant are never
 * deleted, and anything marked Relevant stays in the dealership's own news.
 */
import "./load-env";
import { parseArgs } from "node:util";

async function main() {
  const { values } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
  const { eq, inArray } = await import("drizzle-orm");
  const { db, sqlClient } = await import("@/lib/db");
  const { dealerships, newsArticles, newsKeywords } = await import("@/lib/db/schema");
  const { relevanceKeywords } = await import("@/lib/news/queries");
  const { isNearDuplicate, normalizeTitle, titleTokens } = await import("@/lib/news/relevance");
  const { scoreSourcedArticle } = await import("@/lib/news/source-rules");

  const totals = { examined: 0, rescored: 0, rejected: 0, duplicates: 0, dealership: 0, brand: 0 };

  for (const dealer of await db.select().from(dealerships).orderBy(dealerships.id)) {
    const keywords = await db.select().from(newsKeywords).where(eq(newsKeywords.dealershipId, dealer.id));
    const entities = relevanceKeywords(dealer, keywords);
    const articles = await db.select().from(newsArticles).where(eq(newsArticles.dealershipId, dealer.id));

    type Row = (typeof articles)[number] & { next: ReturnType<typeof scoreSourcedArticle> };
    const keep: Row[] = [];
    const reject: Row[] = [];
    for (const a of articles) {
      totals.examined++;
      // Same per-source rules as the live pipeline: official feeds keep their own posts.
      const next = scoreSourcedArticle(a.sourceType, `${a.title} ${a.summary ?? ""}`, entities);
      if (a.relevance === "relevant") next.scope = "dealership";
      const reviewed = a.relevance !== "new";
      if (next.score === 0 && !reviewed) reject.push({ ...a, next });
      // A reviewed article the rules no longer match keeps its stored score, as brand context unless marked Relevant.
      else keep.push({ ...a, next: next.score === 0 ? { ...next, score: a.relevanceScore, matched: a.matchedKeywords, topics: a.topics } : next });
    }

    // Reviewed articles claim their story first, then the most authoritative source, this store's news, the most relevant and earliest copy.
    keep.sort(
      (x, y) =>
        Number(x.relevance === "new") - Number(y.relevance === "new") ||
        x.sourcePriority - y.sourcePriority ||
        (x.next.scope === y.next.scope ? 0 : x.next.scope === "dealership" ? -1 : 1) ||
        y.next.score - x.next.score ||
        x.detectedAt.getTime() - y.detectedAt.getTime(),
    );
    const stories: Array<Set<string>> = [];
    const duplicates: Row[] = [];
    const survivors: Row[] = [];
    for (const a of keep) {
      const tokens = titleTokens(normalizeTitle(a.title, a.source));
      if (a.relevance === "new" && stories.some((s) => isNearDuplicate(s, tokens))) {
        duplicates.push(a);
        continue;
      }
      stories.push(tokens);
      survivors.push(a);
    }

    const changed = survivors.filter((a) => a.next.score !== a.relevanceScore || a.next.scope !== a.scope || a.next.matched.join("|") !== a.matchedKeywords.join("|") || a.next.topics.join("|") !== a.topics.join("|"));
    const scopeCount = (s: string) => survivors.filter((a) => a.next.scope === s).length;
    console.log(`\n${dealer.name} (#${dealer.id}): ${articles.length} stored → ${survivors.length} kept (${scopeCount("dealership")} dealership, ${scopeCount("brand")} brand)`);
    console.log(`  rejected by current rules: ${reject.length}   duplicate stories: ${duplicates.length}   re-scored: ${changed.length}`);
    for (const a of reject) console.log(`  - reject    ${a.title.slice(0, 100)}`);
    for (const a of duplicates) console.log(`  - duplicate ${a.title.slice(0, 100)}`);
    for (const a of survivors.filter((s) => s.next.scope === "dealership")) console.log(`  ✓ dealership [${a.next.score}] ${a.title.slice(0, 95)}`);

    totals.rescored += changed.length;
    totals.rejected += reject.length;
    totals.duplicates += duplicates.length;
    totals.dealership += scopeCount("dealership");
    totals.brand += scopeCount("brand");

    if (values.apply) {
      await db.transaction(async (tx) => {
        const remove = [...reject, ...duplicates].map((a) => a.id);
        if (remove.length) await tx.delete(newsArticles).where(inArray(newsArticles.id, remove));
        for (const a of changed) {
          await tx
            .update(newsArticles)
            .set({ relevanceScore: a.next.score, scope: a.next.scope, matchedKeywords: a.next.matched, topics: a.next.topics })
            .where(eq(newsArticles.id, a.id));
        }
      });
    }
  }

  console.log(`\n${values.apply ? "Applied" : "Dry run — nothing written. Re-run with --apply to save"}:`, JSON.stringify(totals));
  await sqlClient.end();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
