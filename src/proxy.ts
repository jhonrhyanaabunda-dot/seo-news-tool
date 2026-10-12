import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "a3_session";
// API routes listed here authenticate with their own bearer secrets instead of a session cookie.
const PUBLIC_PATHS = ["/login", "/forgot-password", "/reset-password", "/bot", "/api/health", "/api/cron", "/api/crawl-jobs"];

/**
 * Edge gate: redirects unauthenticated browser requests to /login and adds
 * baseline security headers. Real session validation (database lookup) happens
 * in server components / actions via `requireUser()` — this layer only checks
 * cookie presence so the edge stays fast and database-free.
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
  if (pathname === "/login" && hasSession) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }

  const res = NextResponse.next();
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:png|svg|ico|jpg|jpeg|webp)).*)"],
};
