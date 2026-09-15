import "server-only";
import type { RemoteAuditResult } from "@/lib/db/schema";
import { env } from "@/lib/env";

/**
 * Limited remote check through Google PageSpeed Insights.
 *
 * When a website's firewall blocks the scanner (for example Dealer Inspire
 * sites refusing foreign or data-centre traffic), Google's own servers can
 * usually still load the page. Lighthouse then reports the homepage's SEO
 * basics (title, meta description, indexability, canonical, image alt text,
 * viewport, HTTP status) and performance. It covers the homepage only and
 * does not return the page HTML, so results are labelled "Limited check" and
 * no full score is given. Free with a Google API key (PAGESPEED_API_KEY).
 */
export function remoteAuditAvailable(): boolean {
  return Boolean(env().PAGESPEED_API_KEY) && env().REMOTE_AUDIT_FALLBACK;
}

type Audit = { score?: number | null; scoreDisplayMode?: string; numericValue?: number; details?: { items?: unknown[] } };

export async function runRemoteAudit(url: string, timeoutMs = 150_000): Promise<RemoteAuditResult> {
  const empty: RemoteAuditResult = {
    provider: "pagespeed",
    url,
    finalUrl: url,
    statusOk: null,
    titleOk: null,
    descriptionOk: null,
    crawlable: null,
    canonical: null,
    imagesMissingAlt: null,
    viewportOk: null,
    https: url.startsWith("https:"),
    seoScore: null,
    performance: null,
  };
  const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  api.searchParams.set("url", url);
  api.searchParams.set("strategy", "mobile");
  for (const c of ["seo", "performance", "accessibility", "best-practices"]) api.searchParams.append("category", c);
  api.searchParams.set("key", env().PAGESPEED_API_KEY ?? "");
  let data: { error?: { message?: string }; lighthouseResult?: { finalDisplayedUrl?: string; finalUrl?: string; runtimeError?: { code?: string; message?: string }; categories?: Record<string, { score?: number | null }>; audits?: Record<string, Audit> } };
  try {
    const res = await fetch(api, { signal: AbortSignal.timeout(timeoutMs) });
    data = await res.json();
    if (!res.ok) return { ...empty, error: `Google PageSpeed Insights returned HTTP ${res.status}: ${data.error?.message ?? ""}`.slice(0, 300) };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? `Google PageSpeed Insights request failed: ${err.message}` : "Google PageSpeed Insights request failed" };
  }
  const lr = data.lighthouseResult;
  if (!lr) return { ...empty, error: "Google PageSpeed Insights returned no result" };
  if (lr.runtimeError?.code && lr.runtimeError.code !== "NO_ERROR") {
    return { ...empty, error: `Google could not load the page either (${lr.runtimeError.code}).` };
  }
  const a = lr.audits ?? {};
  const pass = (k: string): boolean | null => {
    const x = a[k];
    if (!x || x.scoreDisplayMode === "notApplicable" || x.scoreDisplayMode === "manual" || x.score === null || x.score === undefined) return null;
    return x.score >= 0.9;
  };
  const statusOk = pass("http-status-code");
  if (statusOk === false) {
    // Google got an HTTP error too — most likely the same firewall. Don't report a block page as site problems.
    return { ...empty, finalUrl: lr.finalDisplayedUrl ?? lr.finalUrl ?? url, statusOk, error: "The website refused Google's check as well (HTTP error)." };
  }
  const canonicalAudit = a["canonical"];
  const canonical: RemoteAuditResult["canonical"] = !canonicalAudit ? null : canonicalAudit.scoreDisplayMode === "notApplicable" ? "missing" : (canonicalAudit.score ?? 0) >= 0.9 ? "ok" : "invalid";
  const imageAlt = a["image-alt"];
  const num = (k: string) => (typeof a[k]?.numericValue === "number" ? a[k].numericValue! : null);
  const perfScore = lr.categories?.performance?.score;
  const seoScore = lr.categories?.seo?.score;
  const finalUrl = lr.finalDisplayedUrl ?? lr.finalUrl ?? url;
  return {
    provider: "pagespeed",
    url,
    finalUrl,
    error: null,
    statusOk,
    titleOk: pass("document-title"),
    descriptionOk: pass("meta-description"),
    crawlable: pass("is-crawlable"),
    canonical,
    imagesMissingAlt: !imageAlt ? null : imageAlt.scoreDisplayMode === "notApplicable" ? 0 : (imageAlt.details?.items?.length ?? 0),
    viewportOk: pass("viewport"),
    https: finalUrl.startsWith("https:"),
    seoScore: typeof seoScore === "number" ? Math.round(seoScore * 100) : null,
    performance: {
      performance: typeof perfScore === "number" ? Math.round(perfScore * 100) : null,
      lcpMs: num("largest-contentful-paint") !== null ? Math.round(num("largest-contentful-paint")!) : null,
      cls: num("cumulative-layout-shift") !== null ? Math.round(num("cumulative-layout-shift")! * 1000) / 1000 : null,
      tbtMs: num("total-blocking-time") !== null ? Math.round(num("total-blocking-time")!) : null,
      fcpMs: num("first-contentful-paint") !== null ? Math.round(num("first-contentful-paint")!) : null,
      strategy: "mobile",
    },
  };
}
