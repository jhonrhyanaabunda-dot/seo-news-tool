import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/guards";
import { accessibleDealershipIds } from "@/lib/auth/tenant";
import { env } from "@/lib/env";
import { getReviewQueue, parseNewsScope, NEWS_SCOPES } from "@/lib/queries/news";
import { topicLabel } from "@/lib/news/relevance";
import { fmtPublished } from "@/components/format";
import { PageHeader, cn } from "@/components/ui";
import { NewsReviewQueue, type QueueArticle } from "@/components/client/news-review-queue";

export const metadata: Metadata = { title: "Review news" };
export const dynamic = "force-dynamic";

const BATCH = 25;
const SCOPE_LABEL: Record<(typeof NEWS_SCOPES)[number], string> = { dealership: "Dealership news", brand: "Brand & industry", all: "Both" };

export default async function NewsReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const scope = parseNewsScope(sp.scope);
  const tz = env().APP_TIMEZONE;
  const { rows, total } = await getReviewQueue({ allowed: await accessibleDealershipIds(user), scope, limit: BATCH });
  const articles: QueueArticle[] = rows.map((r) => {
    const p = fmtPublished(r.publishedAt, r.publishedPrecision, tz);
    return {
      id: r.id,
      title: r.title,
      link: r.originalUrl ?? r.url,
      source: r.source,
      summary: r.summary,
      published: p ? `${p.date}${p.time ? ` · ${p.time}` : ""}` : null,
      relevanceScore: r.relevanceScore,
      matchedKeywords: r.matchedKeywords,
      topics: r.topics.map(topicLabel),
      scope: r.scope,
      dealershipName: r.dealershipName,
    };
  });

  return (
    <>
      <PageHeader
        breadcrumb={
          <Link href="/news" className="hover:underline">
            ← News
          </Link>
        }
        title="Review news"
        description="Unreviewed articles one at a time, most relevant first. Keys: R relevant · N not relevant · Enter reviewed · S skip · U undo · O open the article."
        actions={
          <nav aria-label="Which news" className="flex flex-wrap gap-1">
            {NEWS_SCOPES.map((s) => (
              <Link
                key={s}
                href={s === "dealership" ? "/news/review" : `/news/review?scope=${s}`}
                aria-current={s === scope ? "true" : undefined}
                className={cn("rounded-md px-2.5 py-1 text-xs font-medium ring-1 ring-inset", s === scope ? "bg-brand-600 text-white ring-brand-600" : "bg-white text-slate-600 ring-slate-200 hover:bg-slate-50")}
              >
                {SCOPE_LABEL[s]}
              </Link>
            ))}
          </nav>
        }
      />
      {/* Keyed by the batch so "Load the next batch" starts fresh on the new rows. */}
      <NewsReviewQueue key={`${scope}:${articles.map((a) => a.id).join(",")}`} articles={articles} total={total} />
    </>
  );
}
