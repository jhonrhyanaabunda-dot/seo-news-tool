/**
 * The Content Security Policy, enforced on every page by `src/proxy.ts`.
 *
 * Audit of what the app actually loads (keep this list current when adding
 * anything external):
 *  - Scripts: Next.js bundles from /_next/static plus the inline bootstrap
 *    scripts it emits for hydration and streaming → 'self' 'unsafe-inline'.
 *    (Nonces would allow dropping 'unsafe-inline' but force every page to
 *    render dynamically; the app has no third-party script and no
 *    user-controlled HTML is ever rendered unescaped.) Development also needs
 *    'unsafe-eval' for React's debugging stack reconstruction.
 *  - Styles: Tailwind CSS from /_next/static, React `style={{…}}` attributes
 *    (chart bars) and Next's inline font styles → 'self' 'unsafe-inline'.
 *  - Fonts: Geist via next/font, self-hosted under /_next/static/media → 'self'.
 *  - Images: /_next/image and /public, inline SVG (QR code), data: URIs, blob:
 *    for client-side downloads, and https: for remote pictures such as news
 *    thumbnails or a dealership logo URL entered by an admin.
 *  - Connections: server actions, polling and dev HMR are same-origin.
 *  - The PDF worker prints /report/[id] in Chromium; it loads only same-origin
 *    assets, so the same policy applies.
 *  - Vercel preview deployments inject the Vercel Toolbar (vercel.live), which
 *    is allowed on previews only.
 */

export type CspOptions = {
  /** `next dev`: allows eval for React's dev tooling and the HMR websocket. */
  dev?: boolean;
  /** Vercel preview deployment: allows the Vercel Toolbar. */
  preview?: boolean;
};

const VERCEL_LIVE = "https://vercel.live";

export function cspDirectives({ dev = false, preview = false }: CspOptions = {}): Record<string, string[]> {
  const toolbar = preview ? [VERCEL_LIVE] : [];
  return {
    "default-src": ["'self'"],
    "script-src": ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : []), ...toolbar],
    "style-src": ["'self'", "'unsafe-inline'", ...toolbar],
    "img-src": ["'self'", "data:", "blob:", "https:"],
    "font-src": ["'self'", "data:", ...(preview ? [VERCEL_LIVE, "https://assets.vercel.com"] : [])],
    "connect-src": ["'self'", ...(dev ? ["ws:", "wss:"] : []), ...(preview ? [VERCEL_LIVE, "wss://ws-us3.pusher.com"] : [])],
    "frame-src": preview ? [VERCEL_LIVE] : ["'none'"],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    "form-action": ["'self'"],
    "object-src": ["'none'"],
    "worker-src": ["'self'", "blob:"],
    "manifest-src": ["'self'"],
  };
}

export function buildCsp(opts: CspOptions = {}): string {
  return Object.entries(cspDirectives(opts))
    .map(([name, values]) => `${name} ${values.join(" ")}`)
    .join("; ");
}

/** Resolve the options from the runtime environment (proxy and config). */
export function cspOptionsFromEnv(e: Record<string, string | undefined> = process.env): CspOptions {
  return { dev: e.NODE_ENV === "development", preview: e.VERCEL_ENV === "preview" };
}
