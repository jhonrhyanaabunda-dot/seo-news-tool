/** Link-check classification. Pure, so it can be unit tested without a database. */

/**
 * A link is broken only when the target demonstrably does not work: 404/410,
 * a server error, or (internal links) a network failure. 401/403/429 mean the
 * site's security refused the *check* — common on dealer platforms — so they
 * are "unverifiable", never "broken". A timeout is unverifiable too: a slow
 * answer to a link check is not a dead page, and counting it as broken made a
 * site-wide menu link swing the score between scans (Findlay Subaru: Links
 * 100 ↔ 38 on alternate days with no change on the site).
 */
export function isBrokenLink(isInternal: boolean, status: number | null, errorCode: string | null): boolean {
  if (status !== null) return status === 404 || status === 410 || status >= 500;
  if (isInternal) return errorCode !== null && ["DNS", "CONNECTION", "TLS", "TOO_MANY_REDIRECTS"].includes(errorCode);
  return errorCode === "DNS";
}

/**
 * What kind of redirect an internal link goes through (internal_link_redirects):
 *  - "normalisation": only a trailing slash, letter case or "www." changes.
 *    Sites do this once, site-wide and cheaply; flagging it listed dozens of
 *    links nobody needs to touch, so it is ignored.
 *  - "https": the link is written http:// and lands on the same page over HTTPS.
 *  - "moved": the path changes — an old URL that now redirects elsewhere.
 *  - "offsite": the link leaves the site (lender portals, OEM tools); not ours to judge.
 *  - "ignored": sign-in walls and query-only changes (sessions, filters), which are not stale links.
 */
export type LinkRedirectKind = "normalisation" | "https" | "moved" | "offsite" | "ignored";

const AUTH_PATH_RE = /\/(?:log-?in|sign-?in|auth|account|my-?garage|sso)(?:[/.?-]|$)/i;

export function classifyLinkRedirect(from: string, to: string): LinkRedirectKind {
  let a: URL;
  let b: URL;
  try {
    a = new URL(from);
    b = new URL(to);
  } catch {
    return "ignored";
  }
  const host = (u: URL) => u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  if (host(a) !== host(b)) return "offsite";
  if (AUTH_PATH_RE.test(b.pathname)) return "ignored";
  const path = (u: URL) => (u.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/").toLowerCase();
  if (path(a) !== path(b)) return "moved";
  if (a.search !== b.search) return "ignored";
  if (a.protocol === "http:" && b.protocol === "https:") return "https";
  return "normalisation";
}
