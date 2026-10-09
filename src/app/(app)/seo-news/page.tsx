import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CalendarClock, Newspaper } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { isClient } from "@/lib/auth/tenant";
import { env } from "@/lib/env";
import { getSeoNews, listSeoFeeds, SEO_NEWS_PERIODS } from "@/lib/news/seo-industry";
import { SEO_TOPIC_LABELS, SEO_TOPIC_RULES } from "@/lib/news/seo-topics";
import { fetchSeoNewsNowAction, removeSeoFeedAction, toggleSeoFeedAction } from "@/app/actions/seo-news";
import { SeoFeedForm } from "@/components/admin/seo-feed-form";
import { SubmitButton } from "@/components/client/submit-button";
import { Badge, Card, EmptyState, Notice, PageHeader, Pagination } from "@/components/ui";
import { fmtPublished, fmtRelative } from "@/components/format";

export const metadata: Metadata = { title: "SEO news" };
export const dynamic = "force-dynamic";

const PAGE_SIZE = 30;

export default async function SeoNewsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  // Hidden from the nav for dealership logins; also blocked if one types the URL.
  if (isClient(user)) notFound();
  const isAdmin = user.role === "admin";
  const sp = await searchParams;
  const feedId = Number(sp.feed) || undefined;
  const topic = sp.topic && SEO_TOPIC_LABELS[sp.topic] ? sp.topic : undefined;
  const days = (SEO_NEWS_PERIODS as readonly number[]).includes(Number(sp.days)) ? Number(sp.days) : undefined;
  const page = Math.max(1, Number(sp.p) || 1);
  const tz = env().APP_TIMEZONE;

  const [{ rows, total }, feeds] = await Promise.all([getSeoNews({ feedId, topic, days, page, pageSize: PAGE_SIZE }), listSeoFeeds()]);
  const qs = (p: number) => {
    const q = new URLSearchParams();
    if (feedId) q.set("feed", String(feedId));
    if (topic) q.set("topic", topic);
    if (days) q.set("days", String(days));
    if (p > 1) q.set("p", String(p));
    return `/seo-news${q.size ? `?${q}` : ""}`;
  };
  const lastFetched = feeds.reduce<Date | null>((latest, f) => (f.lastFetchedAt && (!latest || f.lastFetchedAt > latest) ? f.lastFetchedAt : latest), null);
  const failing = feeds.filter((f) => f.isEnabled && f.lastStatus === "error");

  return (
    <>
      {sp.notice === "fetching" && <Notice tone="success">Reading the SEO news feeds now. New articles appear within a minute — refresh the page.</Notice>}
      <PageHeader
        title="SEO news"
        description="The latest articles from leading SEO publications, read from their public RSS feeds (no crawling). The top stories of each week lead the Monday newsletter."
        actions={
          isAdmin ? (
            <form action={fetchSeoNewsNowAction}>
              <SubmitButton className="btn" pendingText="Starting…">
                Fetch now
              </SubmitButton>
            </form>
          ) : undefined
        }
      />

      <form method="get" className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
        <div>
          <label htmlFor="feed" className="label">
            Publication
          </label>
          <select id="feed" name="feed" defaultValue={feedId ?? ""} className="input">
            <option value="">All publications</option>
            {feeds.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="topic" className="label">
            Topic
          </label>
          <select id="topic" name="topic" defaultValue={topic ?? ""} className="input">
            <option value="">All topics</option>
            {SEO_TOPIC_RULES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="days" className="label">
            Published
          </label>
          <select id="days" name="days" defaultValue={days ?? ""} className="input">
            <option value="">Any time</option>
            {SEO_NEWS_PERIODS.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </div>
        <button type="submit" className="btn-primary">
          Apply
        </button>
      </form>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="min-w-0 lg:col-span-2">
          {rows.length === 0 ? (
            <EmptyState
              title={feeds.some((f) => f.articles > 0) ? "No articles match these filters" : "No SEO news yet"}
              description={feeds.some((f) => f.articles > 0) ? "Try a different publication, topic or period." : "Feeds are read every few hours. An admin can use “Fetch now” to read them immediately."}
            />
          ) : (
            <ul className="space-y-3">
              {rows.map((a) => {
                const published = fmtPublished(a.publishedAt ?? a.detectedAt, "datetime", tz);
                return (
                  <li key={a.id} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
                    <article>
                      {a.topics.length > 0 && (
                        <div className="mb-1.5 flex flex-wrap items-center gap-2">
                          {a.topics.map((t) => (
                            <Badge key={t} tone={t === "google_update" ? "warning" : t === "automotive" || t === "local_seo" ? "success" : "accent"}>
                              {SEO_TOPIC_LABELS[t] ?? t}
                            </Badge>
                          ))}
                        </div>
                      )}
                      <h2 className="text-base font-semibold leading-snug text-slate-900">
                        <a href={a.url} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-brand-700 hover:underline">
                          {a.title}
                          <span className="sr-only"> (opens in a new tab)</span>
                        </a>
                      </h2>
                      {a.summary && <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-slate-600">{a.summary}</p>}
                      <dl className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
                        <div className="flex items-center gap-1.5">
                          <dt>
                            <Newspaper aria-hidden className="h-3.5 w-3.5 text-slate-400" />
                            <span className="sr-only">Publication</span>
                          </dt>
                          <dd className="font-medium text-slate-800">{a.source}</dd>
                        </div>
                        {published && (
                          <div className="flex items-center gap-1.5">
                            <dt>
                              <CalendarClock aria-hidden className="h-3.5 w-3.5 text-slate-400" />
                              <span className="sr-only">{a.publishedAt ? "Published" : "Found"}</span>
                            </dt>
                            <dd>
                              {published.date}
                              {published.time ? `, ${published.time}` : ""}
                            </dd>
                          </div>
                        )}
                      </dl>
                    </article>
                  </li>
                );
              })}
            </ul>
          )}
          <Pagination page={page} totalPages={Math.ceil(total / PAGE_SIZE)} hrefFor={qs} />
          <p className="mt-4 text-xs text-slate-500">
            {total} article{total === 1 ? "" : "s"} · times shown in {tz.replace(/_/g, " ")} time{lastFetched ? ` · feeds last read ${fmtRelative(lastFetched)}` : ""}.
          </p>
        </div>

        <div className="space-y-5">
          {failing.length > 0 && (
            <Notice tone="warning">
              {failing.length} feed{failing.length === 1 ? "" : "s"} could not be read last time: {failing.map((f) => f.label).join(", ")}.
            </Notice>
          )}
          <Card title="Publications" description={`${feeds.filter((f) => f.isEnabled).length} of ${feeds.length} feeds on`}>
            <ul className="divide-y divide-slate-100">
              {feeds.map((f) => (
                <li key={f.id} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-slate-800">
                        {f.label}
                        {f.priority === 1 && <Badge tone="info">Official</Badge>}
                        {!f.isEnabled && <Badge>Off</Badge>}
                        {f.isEnabled && f.lastStatus === "error" && <Badge tone="critical">Error</Badge>}
                        {f.isEnabled && f.paused && <Badge tone="warning">Paused</Badge>}
                      </p>
                      <p className="text-xs text-slate-500">
                        {f.articles === 0 && f.lastStatus === "ok" ? "No posts in the last 30 days" : `${f.articles} article${f.articles === 1 ? "" : "s"}`}
                        {f.lastFetchedAt ? ` · read ${fmtRelative(f.lastFetchedAt)}` : " · not read yet"}
                      </p>
                      {isAdmin && f.lastStatus === "error" && f.lastError && <p className="mt-0.5 break-words text-xs text-red-700">{f.lastError}</p>}
                      {isAdmin && f.paused && f.nextFetchAfter && (
                        <p className="mt-0.5 text-xs text-amber-700">
                          {f.lastError?.split(";")[0] ?? "Paused at the publisher’s request"}. Next try {fmtRelative(f.nextFetchAfter)}.
                        </p>
                      )}
                    </div>
                    {isAdmin && (
                      <div className="flex shrink-0 gap-1">
                        <form action={toggleSeoFeedAction}>
                          <input type="hidden" name="feedId" value={f.id} />
                          <input type="hidden" name="enabled" value={f.isEnabled ? "false" : "true"} />
                          <SubmitButton className="btn btn-sm" pendingText="…">
                            {f.isEnabled ? "Turn off" : "Turn on"}
                          </SubmitButton>
                        </form>
                        <form action={removeSeoFeedAction}>
                          <input type="hidden" name="feedId" value={f.id} />
                          <SubmitButton className="btn btn-sm" pendingText="…" confirm={`Remove ${f.label} and its ${f.articles} stored articles?`}>
                            Remove
                          </SubmitButton>
                        </form>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          {isAdmin && (
            <Card title="Add a publication" description="Any SEO publication with an RSS or Atom feed.">
              <SeoFeedForm />
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
