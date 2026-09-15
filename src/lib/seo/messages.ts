/**
 * Human-readable explanations for technical fetch failures. QA reviewers see
 * these instead of raw error codes such as ECONNRESET.
 */
export const FETCH_ERROR_MESSAGES: Record<string, string> = {
  TIMEOUT: "The page took too long to respond during the scan.",
  DNS: "The website address could not be found (DNS lookup failed).",
  CONNECTION: "Unable to access this page during the scan (connection failed or was reset).",
  TLS: "The site's HTTPS certificate could not be verified.",
  TOO_LARGE: "The page is unusually large and could not be fully downloaded.",
  UNSAFE_URL: "This URL points to a non-public address and was skipped for safety.",
  NOT_HTML: "The URL did not return a web page (non-HTML content).",
  TOO_MANY_REDIRECTS: "The page redirects too many times.",
  REDIRECT_OFFSITE: "The page redirects to a different website.",
  HTTP_ERROR: "The server returned an error for this page.",
  ROBOTS_BLOCKED: "robots.txt does not allow this page to be crawled.",
  BLOCKED: "The website's security system blocked the scanner from this page.",
  DUPLICATE: "This URL redirects to a page that was already scanned.",
  NOT_EVALUATED: "Not evaluated: crawling stopped because the website restricted automated access.",
  UNKNOWN: "Unable to access this page during the scan.",
};

export function friendlyFetchError(code: string | null | undefined, httpStatus?: number | null): string {
  if (httpStatus && httpStatus >= 400) {
    if (httpStatus === 401 || httpStatus === 403) return `Access to this page was denied (HTTP ${httpStatus}).`;
    if (httpStatus === 404 || httpStatus === 410) return `This page could not be found (HTTP ${httpStatus}).`;
    if (httpStatus === 429) return "The website asked the scanner to slow down (HTTP 429).";
    if (httpStatus >= 500) return `The website reported a server error (HTTP ${httpStatus}).`;
    return `The server returned an error (HTTP ${httpStatus}).`;
  }
  return FETCH_ERROR_MESSAGES[code ?? "UNKNOWN"] ?? FETCH_ERROR_MESSAGES.UNKNOWN;
}
