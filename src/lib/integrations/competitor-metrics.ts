/**
 * Competitor homepage comparison — pure helpers.
 *
 * Each side is described by the same compact homepage metrics: the dealership
 * from its own latest scan, a competitor from one weekly homepage request. This
 * is deliberately a *homepage comparison*, not a competitor "SEO score": a full
 * scan looks at dozens of pages and checks, one request cannot, and presenting
 * the two as equal would mislead.
 */
import type { CompetitorMetrics } from "@/lib/db/schema";
import type { PageData } from "@/lib/seo/parser";
import { DEALER_SCHEMA_TYPES } from "@/lib/seo/checks/config";

export const MAX_COMPETITORS = 3;

export function emptyMetrics(): CompetitorMetrics {
  return {
    httpStatus: null,
    finalUrl: null,
    https: null,
    titleLength: null,
    descriptionLength: null,
    h1Present: null,
    schemaTypes: null,
    dealerSchema: null,
    pageBytes: null,
    responseMs: null,
    mobileViewport: null,
    rating: null,
    reviewCount: null,
    performance: null,
  };
}

export function hasDealerSchema(types: string[]): boolean {
  return types.some((t) => DEALER_SCHEMA_TYPES.includes(t));
}

/** Metrics from a homepage we fetched and parsed. */
export function metricsFromPage(page: Pick<PageData, "title" | "metaDescription" | "h1" | "schemaTypes" | "hasViewport">, res: { status: number | null; finalUrl: string; bytes: number; totalMs: number }): CompetitorMetrics {
  return {
    ...emptyMetrics(),
    httpStatus: res.status,
    finalUrl: res.finalUrl,
    https: res.finalUrl.startsWith("https://"),
    titleLength: page.title ? page.title.length : 0,
    descriptionLength: page.metaDescription ? page.metaDescription.length : 0,
    h1Present: page.h1.length > 0,
    schemaTypes: [...page.schemaTypes].sort().slice(0, 20),
    dealerSchema: hasDealerSchema(page.schemaTypes),
    pageBytes: res.bytes,
    responseMs: res.totalMs,
    mobileViewport: page.hasViewport,
  };
}

/** The dealership's side, from the homepage row of its latest scan (null fields when details were pruned). */
export function metricsFromScanPage(
  home: { httpStatus: number | null; finalUrl: string | null; url: string; title: string | null; metaDescription: string | null; h1: string[] | null; schemaTypes: string[] | null; htmlBytes: number | null; responseTimeMs: number | null; hasViewport: boolean | null } | null,
  extras: { rating: number | null; reviewCount: number | null; performance: number | null },
): CompetitorMetrics {
  if (!home) return { ...emptyMetrics(), ...extras };
  const finalUrl = home.finalUrl ?? home.url;
  return {
    httpStatus: home.httpStatus,
    finalUrl,
    https: finalUrl.startsWith("https://"),
    titleLength: home.title ? home.title.length : 0,
    descriptionLength: home.metaDescription ? home.metaDescription.length : 0,
    h1Present: home.h1 ? home.h1.length > 0 : null,
    schemaTypes: home.schemaTypes ? [...home.schemaTypes].sort().slice(0, 20) : null,
    dealerSchema: home.schemaTypes ? hasDealerSchema(home.schemaTypes) : null,
    pageBytes: home.htmlBytes,
    responseMs: home.responseTimeMs,
    mobileViewport: home.hasViewport,
    ...extras,
  };
}

export type CellTone = "good" | "bad" | "neutral";
export interface ComparisonCell {
  text: string;
  tone: CellTone;
}
export interface ComparisonRow {
  key: string;
  label: string;
  hint: string;
  cells: ComparisonCell[];
}

const NA: ComparisonCell = { text: "—", tone: "neutral" };

function yesNo(v: boolean | null, goodWhen = true): ComparisonCell {
  if (v === null) return NA;
  return { text: v ? "Yes" : "No", tone: v === goodWhen ? "good" : "bad" };
}

function lengthCell(n: number | null, min: number, max: number): ComparisonCell {
  if (n === null) return NA;
  if (n === 0) return { text: "Missing", tone: "bad" };
  return { text: `${n} chars`, tone: n >= min && n <= max ? "good" : "neutral" };
}

const fmtKb = (b: number) => (b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);

/**
 * Rows of the comparison table. Column 0 is the dealership, then one column per
 * competitor; `null` columns (blocked / not checked yet) render as dashes.
 * Tones are absolute (is this value fine?), not a ranking between columns.
 */
export function comparisonRows(columns: Array<CompetitorMetrics | null>): ComparisonRow[] {
  const cell = (fn: (m: CompetitorMetrics) => ComparisonCell) => columns.map((m) => (m ? fn(m) : NA));
  return [
    { key: "https", label: "Secure (HTTPS)", hint: "Homepage served over HTTPS.", cells: cell((m) => yesNo(m.https)) },
    { key: "title", label: "Title tag", hint: "Present, ideally 30–65 characters.", cells: cell((m) => lengthCell(m.titleLength, 30, 65)) },
    { key: "description", label: "Meta description", hint: "Present, ideally 70–160 characters.", cells: cell((m) => lengthCell(m.descriptionLength, 70, 160)) },
    { key: "h1", label: "H1 heading", hint: "The homepage has a main heading.", cells: cell((m) => yesNo(m.h1Present)) },
    { key: "dealer_schema", label: "Dealer schema", hint: "AutoDealer / LocalBusiness structured data on the homepage.", cells: cell((m) => yesNo(m.dealerSchema)) },
    {
      key: "schema_types",
      label: "Schema types",
      hint: "Structured data types found on the homepage.",
      cells: cell((m) => (m.schemaTypes === null ? NA : { text: m.schemaTypes.length ? m.schemaTypes.slice(0, 4).join(", ") + (m.schemaTypes.length > 4 ? ` +${m.schemaTypes.length - 4}` : "") : "None", tone: "neutral" })),
    },
    { key: "viewport", label: "Mobile viewport", hint: "Declares a mobile viewport.", cells: cell((m) => yesNo(m.mobileViewport)) },
    {
      key: "weight",
      label: "HTML size",
      hint: "Size of the homepage HTML document (not images or scripts).",
      cells: cell((m) => (m.pageBytes === null ? NA : { text: fmtKb(m.pageBytes), tone: m.pageBytes > 1024 * 1024 ? "bad" : "neutral" })),
    },
    {
      key: "response",
      label: "Response time",
      hint: "Time to download the homepage HTML from the monitor (one request; varies).",
      cells: cell((m) => (m.responseMs === null ? NA : { text: `${(m.responseMs / 1000).toFixed(1)} s`, tone: m.responseMs > 3000 ? "bad" : "neutral" })),
    },
    {
      key: "performance",
      label: "Mobile performance",
      hint: "Google PageSpeed (Lighthouse) mobile score, when available.",
      cells: cell((m) => (m.performance === null ? NA : { text: `${m.performance}/100`, tone: m.performance >= 90 ? "good" : m.performance < 50 ? "bad" : "neutral" })),
    },
    { key: "rating", label: "Google rating", hint: "Average star rating of the Google listing.", cells: cell((m) => (m.rating === null ? NA : { text: `${m.rating.toFixed(1)} ★`, tone: "neutral" })) },
    {
      key: "reviews",
      label: "Google reviews",
      hint: "Number of reviews on the Google listing.",
      cells: cell((m) => (m.reviewCount === null ? NA : { text: new Intl.NumberFormat("en-US").format(m.reviewCount), tone: "neutral" })),
    },
  ];
}
