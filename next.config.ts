import type { NextConfig } from "next";

/**
 * Static security headers for every response, including static assets and
 * the proxy's redirects. The Content-Security-Policy is the one exception: it
 * is set by `src/proxy.ts` (built in `src/lib/security/csp.ts`), so each header
 * has exactly one owner and nothing is sent twice with different values.
 */
const SECURITY_HEADERS = [
  // HTTPS only, for two years, on this host and any subdomain.
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // Legacy twin of the CSP's frame-ancestors 'none', for older browsers.
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // Server-only packages with Node built-ins stay external to the server bundle.
  serverExternalPackages: ["postgres", "nodemailer", "rss-parser", "playwright-core"],
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
