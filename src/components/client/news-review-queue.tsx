"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink as ExternalIcon } from "lucide-react";
import { reviewArticleAction } from "@/app/actions/news";
import { Badge, cn } from "@/components/ui";

export type QueueArticle = {
  id: number;
  title: string;
  link: string;
  source: string | null;
  summary: string | null;
  published: string | null;
  relevanceScore: number;
  matchedKeywords: string[];
  topics: string[];
  scope: "dealership" | "brand";
  dealershipName: string;
};

type Decision = "relevant" | "not_relevant" | "reviewed";
type Outcome = Decision | "skipped";
const DECISIONS: Array<{ status: Decision; label: string; key: string; hint: string }> = [
  { status: "relevant", label: "Relevant", key: "r", hint: "R" },
  { status: "not_relevant", label: "Not relevant", key: "n", hint: "N" },
  { status: "reviewed", label: "Reviewed", key: "enter", hint: "Enter" },
];
const DONE_LABEL: Record<Outcome, string> = { relevant: "Relevant", not_relevant: "Not relevant", reviewed: "Reviewed", skipped: "Skipped" };

function Key({ children }: { children: React.ReactNode }) {
  return <kbd className="ml-1.5 rounded border border-slate-200 px-1 text-[10px] font-normal text-slate-500">{children}</kbd>;
}

/**
 * One article at a time with keyboard decisions. Each decision is saved as it is
 * made; skipped articles stay unreviewed and come back next time. When this
 * batch runs out, "Load the next batch" fetches more.
 */
export function NewsReviewQueue({ articles, total }: { articles: QueueArticle[]; total: number }) {
  const router = useRouter();
  const [index, setIndex] = useState(0);
  const [history, setHistory] = useState<Array<{ article: QueueArticle; outcome: Outcome }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const current = articles[index];
  const decided = history.filter((h) => h.outcome !== "skipped").length;

  const decide = useCallback(
    (outcome: Outcome) => {
      if (!current || pending) return;
      setError(null);
      if (outcome === "skipped") {
        setHistory((h) => [...h, { article: current, outcome }]);
        setIndex((i) => i + 1);
        return;
      }
      startTransition(async () => {
        const ok = await reviewArticleAction(current.id, outcome).catch(() => false);
        if (!ok) {
          setError("That decision wasn't saved. Check your connection and try again.");
          return;
        }
        setHistory((h) => [...h, { article: current, outcome }]);
        setIndex((i) => i + 1);
      });
    },
    [current, pending],
  );

  const undo = useCallback(() => {
    const last = history[history.length - 1];
    if (!last || pending) return;
    setError(null);
    startTransition(async () => {
      if (last.outcome !== "skipped") {
        const ok = await reviewArticleAction(last.article.id, "new", last.article.scope).catch(() => false);
        if (!ok) {
          setError("Couldn't undo. Try again.");
          return;
        }
      }
      setHistory((h) => h.slice(0, -1));
      setIndex((i) => Math.max(0, i - 1));
    });
  }, [history, pending]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      // Enter on a focused button or link already activates it; don't decide twice.
      if (e.key === "Enter" && t && (t.tagName === "BUTTON" || t.tagName === "A")) return;
      const k = e.key.toLowerCase();
      const d = DECISIONS.find((x) => x.key === k);
      if (d) decide(d.status);
      else if (k === "s") decide("skipped");
      else if (k === "u") undo();
      else if (k === "o" && current) window.open(current.link, "_blank", "noopener,noreferrer");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, undo, current]);

  const remaining = Math.max(0, total - decided);
  const last = history[history.length - 1];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm text-slate-600">
        <span>
          <span className="font-semibold tabular-nums text-slate-900">{remaining}</span> left to review
          {decided > 0 && <span className="text-slate-500"> · {decided} done this session</span>}
        </span>
        <span aria-live="polite" className="min-w-0 truncate text-slate-500">
          {last && (
            <>
              {DONE_LABEL[last.outcome]}: <span className="text-slate-700">{last.article.title}</span>
            </>
          )}
        </span>
      </div>
      <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
        <div className="h-full rounded-full bg-brand-600 transition-all" style={{ width: `${articles.length ? Math.min(100, (index / articles.length) * 100) : 100}%` }} />
      </div>

      {error && <p className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 ring-1 ring-inset ring-red-200">{error}</p>}

      {current ? (
        <article aria-labelledby="queue-title" className={cn("rounded-lg border border-slate-200 bg-white p-5 shadow-[var(--shadow-card)] transition-opacity", pending && "opacity-60")}>
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge>{current.dealershipName}</Badge>
            {current.scope === "brand" && <Badge tone="info">Brand &amp; industry</Badge>}
            {current.topics.map((t) => (
              <Badge key={t}>{t}</Badge>
            ))}
            <span className="ml-auto text-xs tabular-nums text-slate-500">Relevance {current.relevanceScore}</span>
          </div>
          <h2 id="queue-title" className="text-lg font-semibold leading-snug text-slate-900">
            {current.title}
          </h2>
          <p className="mt-1 text-xs text-slate-500">
            {current.source ?? "Unknown source"}
            {current.published ? ` · ${current.published}` : " · publication date not provided"}
          </p>
          {current.summary ? <p className="mt-3 text-sm leading-relaxed text-slate-700">{current.summary}</p> : <p className="mt-3 text-sm italic text-slate-400">No summary provided by the source.</p>}
          {current.matchedKeywords.length > 0 && <p className="mt-3 text-xs text-slate-500">Matched: {current.matchedKeywords.join(", ")}</p>}
          <a href={current.link} target="_blank" rel="noopener noreferrer nofollow" className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
            Read original article <ExternalIcon aria-hidden className="h-3.5 w-3.5" />
            <span className="sr-only">(opens in a new tab)</span>
            <Key>O</Key>
          </a>

          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
            {DECISIONS.map((d) => (
              <button key={d.status} type="button" disabled={pending} onClick={() => decide(d.status)} className={cn("btn", d.status === "relevant" && "!border-emerald-300 hover:!bg-emerald-50")}>
                {d.label}
                <Key>{d.hint}</Key>
              </button>
            ))}
            <button type="button" disabled={pending} onClick={() => decide("skipped")} className="btn">
              Skip
              <Key>S</Key>
            </button>
            <button type="button" disabled={pending || history.length === 0} onClick={undo} className="btn sm:ml-auto">
              Undo
              <Key>U</Key>
            </button>
          </div>
        </article>
      ) : (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center shadow-[var(--shadow-card)]">
          <h2 className="text-base font-semibold text-slate-900">{remaining > 0 ? "End of this batch" : "All caught up"}</h2>
          <p className="mt-1 text-sm text-slate-500">
            {remaining > 0 ? `${remaining} more unreviewed article${remaining === 1 ? "" : "s"}, including any you skipped.` : "Every article in this view has been reviewed."}
          </p>
          <div className="mt-4 flex justify-center gap-2">
            {history.length > 0 && (
              <button type="button" onClick={undo} disabled={pending} className="btn">
                Undo last
              </button>
            )}
            {remaining > 0 && (
              <button
                type="button"
                className="btn-primary"
                disabled={pending}
                // In one transition, so the reset lands with the new rows (and still happens when only skipped ones come back).
                onClick={() =>
                  startTransition(() => {
                    router.refresh();
                    setIndex(0);
                    setHistory([]);
                  })
                }
              >
                Load the next batch
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
