import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, cspOptionsFromEnv } from "@/lib/security/csp";

const SESSION_COOKIE = "a3_session";
// API routes listed here authenticate with their own bearer secrets instead of a session cookie.
const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password", "/bot", "/api/health", "/api/cron", "/api/crawl-jobs"];

/** Computed once per process: the policy only varies with the deployment (dev / Vercel preview). */
const CSP = buildCsp(cspOptionsFromEnv());

/**
 * Edge gate: redirects unauthenticated browser requests to /login and enforces
 * the Content Security Policy. Real session validation (database lookup)
 * happens in server components / actions via `requireUser()` — this layer only
 * checks cookie presence so the edge stays fast and database-free.
 *
 * Header ownership: the static security headers (HSTS, nosniff, frame and
 * referrer policy, permissions policy) are set once for every path in
 * `next.config.ts`; only the CSP is set here, so no header is sent twice.
 */
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isPublic = PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"));
  const hasSession = Boolean(request.cookies.get(SESSION_COOKIE)?.value);
  // The report renderer has no cookie, only a single-purpose key. This edge
  // layer just lets the request reach the page; the key itself is verified
  // against the database there, and authorises one dealership's report only.
  const hasRenderKey = pathname.startsWith("/report/") && Boolean(request.nextUrl.searchParams.get("rt"));

  if (!isPublic && !hasSession && !hasRenderKey) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = pathname !== "/" ? `?next=${encodeURIComponent(pathname + request.nextUrl.search)}` : "";
    return NextResponse.redirect(url);
  }
  // No "/login → /" redirect on cookie presence here: a stale cookie (expired or
  // revoked session) would bounce between / and /login forever. The login page
  // itself sends signed-in users home after validating the session.

  const res = NextResponse.next();
  // Enforced (no longer report-only). See src/lib/security/csp.ts for what it allows and why.
  res.headers.set("Content-Security-Policy", CSP);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|svg|ico|jpg|jpeg|webp)).*)"],
};
