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
