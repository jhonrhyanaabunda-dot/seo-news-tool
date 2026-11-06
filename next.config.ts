import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  experimental: {
    // Going back to a page seen in the last 30 seconds is instant. Anything saved clears this
    // (server actions revalidate), and the scan banner refreshes itself.
    staleTimes: { dynamic: 30 },
  },
  // Server-only packages with Node built-ins stay external to the server bundle.
  serverExternalPackages: ["postgres", "nodemailer", "rss-parser", "playwright-core"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
