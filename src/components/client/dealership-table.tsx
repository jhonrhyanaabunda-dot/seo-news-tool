"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Download, Search, X } from "lucide-react";
import clsx from "clsx";
import { Badge, DEALER_STATUS, ScoreBadge, ScoreDelta, type DealerStatus } from "@/components/ui";

export interface DealerTableRow {
  id: number;
  name: string;
  brand: string;
  location: string;
  score: number | null;
  scoreDelta: number | null;
  critical: number;
  warnings: number;
  newNews: number;
  lastScanLabel: string;
  lastScanSort: number;
  status: DealerStatus;
  statusDetail: string | null;
  pagesAnalyzed: number;
  pagesProtected: number;
}

type SortKey = "name" | "score" | "critical" | "warnings" | "pages" | "protected" | "newNews" | "lastScan" | "status";
const SORT_KEYS: SortKey[] = ["name", "score", "critical", "warnings", "pages", "protected", "newNews", "lastScan", "status"];
const STATUS_ORDER: DealerStatus[] = ["down", "blocked", "limited", "partially_blocked", "failed", "critical", "attention", "scanning", "not_scanned", "healthy", "paused"];

export interface DealerTableInitial {
  q?: string;
  status?: string;
  sort?: string;
  dir?: string;
}

function parseInitial(initial: DealerTableInitial) {
  const status = initial.status && (STATUS_ORDER as string[]).includes(initial.status) ? (initial.status as DealerStatus) : "all";
  const key = initial.sort && SORT_KEYS.includes(initial.sort as SortKey) ? (initial.sort as SortKey) : "status";
  const dir: 1 | -1 = initial.dir === "desc" ? -1 : initial.dir === "asc" ? 1 : key === "name" || key === "status" ? 1 : -1;
  return { query: initial.q ?? "", status: status as "all" | DealerStatus, sort: { key, dir } };
}

/** Mirror view state into the URL without a server round-trip, so refresh/share/back keep the view. */
function syncUrl(query: string, status: string, sort: { key: SortKey; dir: 1 | -1 }) {
  if (typeof window === "undefined") return;
  const p = new URLSearchParams(window.location.search);
  const set = (key: string, value: string | null) => {
    if (value === null) p.delete(key);
    else p.set(key, value);
  };
  const defaultDir = sort.key === "name" || sort.key === "status" ? 1 : -1;
  set("q", query || null);
  set("status", status !== "all" ? status : null);
  set("sort", sort.key !== "status" ? sort.key : null);
  set("dir", sort.dir !== defaultDir ? (sort.dir === 1 ? "asc" : "desc") : null);
  const qs = p.toString();
  window.history.replaceState(null, "", qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
}

function toCsv(rows: DealerTableRow[]): string {
  const esc = (v: string | number | null) => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = ["Dealership", "Brand", "Location", "SEO score", "Change", "Critical", "Warnings", "Pages analyzed", "Protected pages", "New news", "Last scan", "Status"];
  const body = rows.map((r) => [r.name, r.brand, r.location, r.score, r.scoreDelta, r.critical, r.warnings, r.pagesAnalyzed, r.pagesProtected, r.newNews, r.lastScanLabel, DEALER_STATUS[r.status].label].map(esc).join(","));
  return [head.join(","), ...body].join("\n");
}

export function DealershipTable({ rows, initial = {} }: { rows: DealerTableRow[]; initial?: DealerTableInitial }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [navigatingId, setNavigatingId] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const start = useMemo(() => parseInitial(initial), [initial]);
  const [query, setQuery] = useState(start.query);
  const [status, setStatus] = useState<"all" | DealerStatus>(start.status);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>(start.sort);

  useEffect(() => {
    syncUrl(query, status, sort);
  }, [query, status, sort]);

  // "/" focuses search the way it does in most dashboards; Escape clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === "Escape" && el === searchRef.current) {
        setQuery("");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const go = useCallback(
    (id: number) => {
      setNavigatingId(id);
      startTransition(() => router.push(`/dealerships/${id}`));
    },
    [router],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = rows.filter((r) => (status === "all" || r.status === status) && (!q || `${r.name} ${r.brand} ${r.location}`.toLowerCase().includes(q)));
    const val = (r: DealerTableRow): number | string => {
      switch (sort.key) {
        case "name":
          return r.name.toLowerCase();
        case "score":
          return r.score ?? -1;
        case "critical":
          return r.critical;
        case "warnings":
          return r.warnings;
        case "pages":
          return r.pagesAnalyzed;
        case "protected":
          return r.pagesProtected;
        case "newNews":
          return r.newNews;
        case "lastScan":
          return r.lastScanSort;
        case "status":
          return STATUS_ORDER.indexOf(r.status);
      }
    };
    return [...list].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (va < vb) return -1 * sort.dir;
      if (va > vb) return 1 * sort.dir;
      return a.name.localeCompare(b.name);
    });
  }, [rows, query, status, sort]);

  const counts = useMemo(() => {
    const c: Partial<Record<DealerStatus, number>> = {};
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return c;
  }, [rows]);

  const exportCsv = () => {
    const blob = new Blob([toCsv(filtered)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dealerships-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isFiltered = query.trim() !== "" || status !== "all";

  const header = (key: SortKey, label: string, align: "left" | "right" = "left") => {
    const active = sort.key === key;
    return (
      <th scope="col" aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={align === "right" ? "!text-right" : undefined}>
        <button
          type="button"
          onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((s.dir * -1) as 1 | -1) : key === "name" || key === "status" ? 1 : -1 }))}
          className={clsx("inline-flex items-center gap-1 uppercase", active && "text-slate-900")}
        >
          {label}
          {active && (sort.dir === 1 ? <ArrowUp aria-hidden className="h-3 w-3" /> : <ArrowDown aria-hidden className="h-3 w-3" />)}
        </button>
      </th>
    );
  };

  return (
    <div>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative sm:w-80">
          <Search aria-hidden className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <label htmlFor="dealer-search" className="sr-only">
            Search dealerships
          </label>
          <input
            id="dealer-search"
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search name, brand or city…"
            className="input pl-8 pr-8"
          />
          {!query && <kbd className="pointer-events-none absolute right-2.5 top-2 hidden rounded border border-slate-200 bg-slate-50 px-1.5 text-xs text-slate-400 sm:block">/</kbd>}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="status-filter" className="text-sm text-slate-600">
            Status
          </label>
          <select id="status-filter" value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="input w-auto py-1.5">
            <option value="all">All ({rows.length})</option>
            {STATUS_ORDER.filter((s) => counts[s]).map((s) => (
              <option key={s} value={s}>
                {DEALER_STATUS[s].label} ({counts[s]})
              </option>
            ))}
          </select>
          {isFiltered && (
            <button
              type="button"
              onClick={() => {
                setQuery("");
                setStatus("all");
              }}
              className="btn btn-sm"
            >
              <X aria-hidden className="h-3 w-3" /> Clear
            </button>
          )}
          <button type="button" onClick={exportCsv} className="btn btn-sm" disabled={filtered.length === 0} title="Download the rows below as CSV">
            <Download aria-hidden className="h-3 w-3" /> Export
          </button>
        </div>
      </div>
      <div className={clsx("overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm transition-opacity", pending && "opacity-60")}>
        <table className="table-base">
          <caption className="sr-only">Dealerships with their latest SEO score, issues, news and scan status. Select a dealership to open its report.</caption>
          <thead>
            <tr>
              {header("name", "Dealership")}
              {header("score", "SEO score", "right")}
              {header("critical", "Critical", "right")}
              {header("warnings", "Warnings", "right")}
              {header("pages", "Pages", "right")}
              {header("protected", "Protected", "right")}
              {header("newNews", "New news", "right")}
              {header("lastScan", "Last scan")}
              {header("status", "Status")}
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr>
                <td colSpan={9} className="py-8 text-center text-slate-500">
                  No dealerships match your filters.
                </td>
              </tr>
            )}
            {filtered.map((r) => (
              <tr
                key={r.id}
                className={clsx("cursor-pointer hover:bg-slate-50", navigatingId === r.id && "bg-brand-50")}
                onClick={() => {
                  // Dragging to select text inside a row must not navigate away.
                  if (window.getSelection()?.toString()) return;
                  go(r.id);
                }}
              >
                <td>
                  <Link
                    href={`/dealerships/${r.id}`}
                    className="font-medium text-slate-900 hover:text-brand-700 hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      setNavigatingId(r.id);
                    }}
                  >
                    {r.name}
                  </Link>
                  <div className="text-xs text-slate-500">
                    {r.brand}
                    {r.location && ` · ${r.location}`}
                  </div>
                </td>
                <td className="text-right">
                  <div className="flex flex-col items-end">
                    <ScoreBadge score={r.score} />
                    <ScoreDelta delta={r.scoreDelta} />
                  </div>
                </td>
                <td className="text-right tabular-nums">{r.critical > 0 ? <span className="font-semibold text-red-700">{r.critical}</span> : <span className="text-slate-400">0</span>}</td>
                <td className="text-right tabular-nums">{r.warnings > 0 ? <span className="font-medium text-amber-700">{r.warnings}</span> : <span className="text-slate-400">0</span>}</td>
                <td className="text-right tabular-nums text-slate-700">{r.pagesAnalyzed}</td>
                <td className="text-right tabular-nums">
                  {r.pagesProtected > 0 ? (
                    <span title="Pages the website's security prevented the monitor from analysing. Not SEO issues.">
                      <Badge tone="warning">{r.pagesProtected}</Badge>
                    </span>
                  ) : (
                    <span className="text-slate-400">0</span>
                  )}
                </td>
                <td className="text-right tabular-nums">{r.newNews > 0 ? <Badge tone="accent">{r.newNews}</Badge> : <span className="text-slate-400">0</span>}</td>
                <td className="whitespace-nowrap text-slate-600">{r.lastScanLabel}</td>
                <td>
                  <span title={r.statusDetail ?? undefined}>
                    <Badge tone={DEALER_STATUS[r.status].tone}>{DEALER_STATUS[r.status].label}</Badge>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-slate-500" aria-live="polite">
        Showing {filtered.length} of {rows.length} dealerships.
      </p>
    </div>
  );
}
