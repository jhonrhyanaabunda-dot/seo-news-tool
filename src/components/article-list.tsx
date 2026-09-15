import Link from "next/link";
import { Building2, CalendarClock, ExternalLink as ExternalIcon, Newspaper } from "lucide-react";
import type { getNews } from "@/lib/queries/news";
import { topicLabel } from "@/lib/news/relevance";
import { SOURCE_LABEL } from "@/lib/news/source-rules";
import { setArticleStatusAction } from "@/app/actions/news";
import { SubmitButton } from "@/components/client/submit-button";
import { Badge, cn } from "@/components/ui";
import { fmtDateTime, fmtPublished } from "@/components/format";

type ArticleRow = Awaited<ReturnType<typeof getNews>>["rows"][number];

export function ArticleList({ rows, tz, minScore }: { rows: ArticleRow[]; tz: string; minScore: number }) {
  return (
    <ul className="space-y-3">
      {rows.map((a) => (
        <ArticleItem key={a.id} a={a} tz={tz} minScore={minScore} />
      ))}
    </ul>
  );
}

const STATUS_BADGE: Record<string, React.ReactNode> = {
  new: <Badge tone="accent">New</Badge>,
  relevant: <Badge tone="success">Relevant</Badge>,
  reviewed: <Badge>Reviewed</Badge>,
  not_relevant: <Badge>Not relevant</Badge>,
};

function ArticleItem({ a, tz, minScore }: { a: ArticleRow; tz: string; minScore: number }) {
  const published = fmtPublished(a.publishedAt, a.publishedPrecision, tz);
  const link = a.originalUrl ?? a.url;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <article className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-2">
            {STATUS_BADGE[a.relevance]}
            {a.scope === "brand" && <Badge tone="info">Brand &amp; industry</Badge>}
            {a.sourceType !== "search" && <Badge tone={a.sourceType === "dealership" || a.sourceType === "crawl" ? "success" : "accent"}>{SOURCE_LABEL[a.sourceType]}</Badge>}
            {a.scope === "dealership" && a.relevanceScore >= minScore && <Badge tone="warning">High relevance</Badge>}
            {a.topics.map((t) => (
              <Badge key={t}>{topicLabel(t)}</Badge>
            ))}
          </div>

          <h3 className="text-base font-semibold leading-snug text-slate-900">
            <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-brand-700 hover:underline">
              {a.title}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </h3>

          {a.summary ? <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-slate-600">{a.summary}</p> : <p className="mt-1 text-sm italic text-slate-400">No summary provided by the source.</p>}

          <dl className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
            <div className="flex items-center gap-1.5">
              <dt>
                <Building2 aria-hidden className="h-3.5 w-3.5 text-slate-400" />
                <span className="sr-only">Dealership</span>
              </dt>
              <dd>
                <Link href={`/dealerships/${a.dealershipId}?tab=news`} className="font-medium text-slate-800 hover:underline">
                  {a.dealershipName}
                </Link>
              </dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt>
                <Newspaper aria-hidden className="h-3.5 w-3.5 text-slate-400" />
                <span className="sr-only">Source</span>
              </dt>
              <dd>{a.source ?? "Unknown source"}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt>
                <CalendarClock aria-hidden className="h-3.5 w-3.5 text-slate-400" />
                <span className="sr-only">Published</span>
              </dt>
              <dd>
                {published ? (
                  <time dateTime={a.publishedAt!.toISOString()} className="font-medium text-slate-800">
                    {published.date}
                    {published.time ? ` · ${published.time}` : ""}
                  </time>
                ) : (
                  <span>Publication date not provided</span>
                )}
                {published && !published.time && <span className="text-slate-500"> · time not provided by the source</span>}
              </dd>
            </div>
          </dl>

          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <a href={link} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline">
              Read original article <ExternalIcon aria-hidden className="h-3 w-3" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
            <span>Detected {fmtDateTime(a.detectedAt, tz)}</span>
            <span>Relevance {a.relevanceScore}</span>
            {a.matchedKeywords.length > 0 && <span>Matched: {a.matchedKeywords.join(", ")}</span>}
          </div>
        </div>

        <form action={setArticleStatusAction} className="flex shrink-0 flex-wrap gap-1.5">
          <input type="hidden" name="articleId" value={a.id} />
          <SubmitButton name="status" value="relevant" className={cn("btn btn-sm", a.relevance === "relevant" && "!border-emerald-400 !bg-emerald-50")} pendingText="…">
            Relevant
          </SubmitButton>
          <SubmitButton name="status" value="not_relevant" className={cn("btn btn-sm", a.relevance === "not_relevant" && "!bg-slate-100")} pendingText="…">
            Not relevant
          </SubmitButton>
          <SubmitButton name="status" value="reviewed" className={cn("btn btn-sm", a.relevance === "reviewed" && "!bg-slate-100")} pendingText="…">
            Reviewed
          </SubmitButton>
        </form>
      </article>
    </li>
  );
}
