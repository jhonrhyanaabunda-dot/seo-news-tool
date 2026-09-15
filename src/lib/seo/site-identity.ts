import { canonicalHost } from "./url";

/** The website a scan belongs to (host without "www."), used to keep history per website. */
export function siteKey(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return canonicalHost(new URL(url).hostname);
  } catch {
    return null;
  }
}

export function scanSiteKey(scan: { websiteUrl?: string | null; crawlState?: { baseUrl?: string } | null }): string | null {
  return siteKey(scan.websiteUrl) ?? siteKey(scan.crawlState?.baseUrl);
}

/** Two scans are comparable only when they scanned the same website. */
export function sameWebsite(a: { websiteUrl?: string | null; crawlState?: { baseUrl?: string } | null }, b: { websiteUrl?: string | null; crawlState?: { baseUrl?: string } | null }): boolean {
  const ka = scanSiteKey(a);
  return ka !== null && ka === scanSiteKey(b);
}
