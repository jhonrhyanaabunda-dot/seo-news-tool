/**
 * Detect when a website's bot protection (Akamai, Cloudflare, Imperva,
 * PerimeterX, DataDome…) served the scanner a block/challenge page instead
 * of the real content. Such responses must not be reported as SEO problems
 * or "website down" — the site works for visitors; only the scanner was
 * refused. Pure function so it can be unit tested.
 */

const MARKERS: Array<{ vendor: string; pattern: RegExp }> = [
  { vendor: "Akamai", pattern: /<title>\s*Access Denied\s*<\/title>[\s\S]*?(Reference\s*#|errors\.edgesuite\.net)/i },
  { vendor: "Cloudflare", pattern: /(cf-browser-verification|cf_chl_opt|challenge-platform|Enable JavaScript and cookies to continue|<title>\s*(Just a moment\.\.\.|Attention Required! \| Cloudflare)\s*<\/title>)/i },
  // Dealer Inspire's branded Cloudflare challenge ("Dealer Website" page with di-cf-* markup).
  { vendor: "Cloudflare (Dealer Inspire)", pattern: /class="di-cf-|<title>\s*Dealer Website\s*<\/title>[\s\S]*cf-/i },
  { vendor: "Imperva", pattern: /(_Incapsula_Resource|Request unsuccessful\. Incapsula incident)/i },
  { vendor: "PerimeterX", pattern: /(px-captcha|_pxAppId|perimeterx)/i },
  { vendor: "DataDome", pattern: /(datadome|dd_cookie_test|geo\.captcha-delivery\.com)/i },
  { vendor: "Sucuri", pattern: /(Sucuri WebSite Firewall|sucuri\.net\/privacy-policy)/i },
  { vendor: "Generic challenge", pattern: /(<title>\s*(Pardon Our Interruption|Checking your browser|Security check|Bot verification)\s*<\/title>|g-recaptcha[\s\S]{0,400}verify you are (a )?human)/i },
];

export interface BlockVerdict {
  blocked: boolean;
  vendor: string | null;
  reason: string | null;
}

export function detectBlock(res: { status: number | null; headers: Record<string, string>; body: string | null }): BlockVerdict {
  // Challenge pages can embed ~200 KB of fonts/styles before their markers, so scan the whole
  // (size-capped) body — with inline <style> blocks removed to keep the regexes fast.
  const body = (res.body ?? "").slice(0, 1_500_000).replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  for (const m of MARKERS) {
    if (m.pattern.test(body)) return { blocked: true, vendor: m.vendor, reason: `${m.vendor} bot protection returned a challenge page` };
  }
  const server = (res.headers["server"] ?? "").toLowerCase();
  if (res.status === 401 || res.status === 403 || res.status === 429) {
    const vendor = server.includes("akamai") ? "Akamai" : server.includes("cloudflare") || res.headers["cf-ray"] ? "Cloudflare" : null;
    // A 403 with a real-looking page body (a genuine "forbidden" page on a normal site) is still an access refusal for the scanner.
    return { blocked: true, vendor, reason: `The website refused the scanner (HTTP ${res.status})${vendor ? ` — ${vendor}` : ""}` };
  }
  return { blocked: false, vendor: null, reason: null };
}
