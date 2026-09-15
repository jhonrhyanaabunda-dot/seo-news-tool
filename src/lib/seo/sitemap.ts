import "server-only";
import { gunzipSync } from "node:zlib";
import * as cheerio from "cheerio";
import { safeFetch } from "./fetcher";
import { browserRetryRaw } from "./browser-fetch";
import { planFetch } from "./render-policy";
import { env } from "@/lib/env";
import type { RenderMode } from "@/lib/db/schema";
import { detectBlock } from "./block-detect";
import { CRAWL_POLICY } from "./crawl-policy";
import { getCached, setCached } from "./site-cache";
import { canonicalHost, isSameSite } from "./url";

export interface SitemapInfo {
  found: boolean;
  url: string | null;
  urlCount: number;
  urls: string[];
  childSitemaps: number;
  /** A sitemap request was refused by bot protection, so its state is unknown (not "missing"). */
  blocked?: boolean;
  cached?: boolean;
  error?: string;
}

const MAX_CHILD_SITEMAPS = 5;
const MAX_URLS = 5000;

type XmlResult = { xml: string | null; status: number | null; blocked: boolean; error?: string };

async function fetchXml(url: string, renderMode: RenderMode = "auto"): Promise<XmlResult> {
  const opts = { maxBytes: 8 * 1024 * 1024, retries: 1, accept: "application/xml,text/xml,*/*;q=0.8" };
  let res = await safeFetch(url, opts);
  // A refused sitemap is not a missing sitemap. Retry through the browser's
  // cookie jar, which by this point holds whatever the site issued while the
  // homepage was read, so the sitemap is judged on what the site actually serves.
  if (detectBlock(res).blocked && planFetch(renderMode, env().BROWSER_RENDERING) !== "http-only") {
    const raw = await browserRetryRaw(url, opts);
    if (raw && !detectBlock(raw).blocked) res = raw;
  }
  if (detectBlock(res).blocked) return { xml: null, status: res.status, blocked: true, error: "Blocked by website security" };
  if (!res.ok || res.body === null) return { xml: null, status: res.status, blocked: false, error: res.errorMessage ?? (res.status ? `HTTP ${res.status}` : "Unavailable") };
  let body = res.body;
  // Gzipped sitemaps (.xml.gz) arrive as binary; decode when the magic bytes match.
  if (url.endsWith(".gz") || body.charCodeAt(0) === 0x1f) {
    try {
      body = gunzipSync(Buffer.from(body, "binary")).toString("utf8");
    } catch {
      /* not gzipped after all */
    }
  }
  if (!/<(urlset|sitemapindex)/i.test(body)) return { xml: null, status: res.status, blocked: false, error: "Not a valid XML sitemap" };
  return { xml: body, status: res.status, blocked: false };
}

/**
 * Locate and parse the site's XML sitemap. Supports sitemap indexes (bounded)
 * and gzip. Results are cached per host for a day. If the site refuses a
 * sitemap request, stop immediately (no further attempts) and report the
 * sitemap as unknown rather than missing.
 */
export async function loadSitemap(
  siteUrl: string,
  candidates: string[],
  opts: { useCache?: boolean; renderMode?: RenderMode; /** Admin-configured sitemap: a cached copy of a different one is ignored. */ preferredUrl?: string | null } = {},
): Promise<SitemapInfo> {
  const site = new URL(siteUrl);
  const host = canonicalHost(site.hostname);
  if (opts.useCache !== false) {
    const hit = await getCached<SitemapInfo>(host, "sitemap", CRAWL_POLICY.sitemapCacheHours);
    if (hit && (!opts.preferredUrl || hit.url === opts.preferredUrl)) return { ...hit, cached: true };
  }
  const tried = new Set<string>();
  const list = [...candidates, new URL("/sitemap.xml", siteUrl).toString(), new URL("/sitemap_index.xml", siteUrl).toString()];
  let lastError: string | undefined;

  for (const candidate of list) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    let target: URL;
    try {
      target = new URL(candidate);
    } catch {
      continue;
    }
    if (!isSameSite(site, target)) continue;

    const main = await fetchXml(candidate, opts.renderMode);
    if (main.blocked) return { found: false, url: candidate, urlCount: 0, urls: [], childSitemaps: 0, blocked: true, error: main.error };
    if (!main.xml) {
      lastError = main.error;
      continue;
    }
    const urls = new Set<string>();
    let children = 0;
    const $ = cheerio.load(main.xml, { xml: true });
    const childLocs = $("sitemapindex > sitemap > loc")
      .map((_, el) => $(el).text().trim())
      .get();
    if (childLocs.length) {
      for (const child of childLocs.slice(0, MAX_CHILD_SITEMAPS)) {
        children++;
        const c = await fetchXml(child, opts.renderMode);
        if (c.blocked) break; // don't keep knocking on a door that was refused
        if (!c.xml) continue;
        const $$ = cheerio.load(c.xml, { xml: true });
        $$("urlset > url > loc").each((_, el) => {
          if (urls.size < MAX_URLS) urls.add($$(el).text().trim());
        });
      }
    } else {
      $("urlset > url > loc").each((_, el) => {
        if (urls.size < MAX_URLS) urls.add($(el).text().trim());
      });
    }
    const sameSite = [...urls].filter((u) => {
      try {
        return isSameSite(site, new URL(u));
      } catch {
        return false;
      }
    });
    const info: SitemapInfo = { found: true, url: candidate, urlCount: sameSite.length, urls: sameSite, childSitemaps: children };
    await setCached(host, "sitemap", info);
    return info;
  }
  return { found: false, url: null, urlCount: 0, urls: [], childSitemaps: 0, error: lastError };
}
