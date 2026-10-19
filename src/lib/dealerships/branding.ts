/**
 * Dealership branding: a logo URL and a brand colour, used on the report, the
 * PDF and single-dealership emails, falling back to A3's own styling.
 *
 * Pure module (no database, no network) so the validation and the contrast
 * rule are unit-tested. The DNS half of the logo check (public host) is done by
 * `assertSafeUrl` in dealerships/service.ts, because the PDF worker's Chromium
 * does fetch the logo when it prints the report.
 */

export const LOGO_URL_MAX = 500;
/** A3's default report/email header colour (templates.ts `C.brand`). */
export const A3_BRAND_COLOR = "#0F2747";

/** "#1a2B3c" → "#1A2B3C"; anything else → null. Only the six-digit form is accepted. */
export function normalizeBrandColor(input: string | null | undefined): string | null {
  const v = (input ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : null;
}

/**
 * Shape check for a logo address: https only, no credentials, default port,
 * a dotted hostname that is not an IP literal, and a sane length. Returns the
 * normalised URL or an error message. Hosts are resolved separately.
 */
export function checkLogoUrlShape(input: string): { ok: true; url: string } | { ok: false; error: string } {
  const v = input.trim();
  if (v.length > LOGO_URL_MAX) return { ok: false, error: `The logo address must be at most ${LOGO_URL_MAX} characters.` };
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return { ok: false, error: "Enter the full logo address, e.g. https://www.example.com/logo.png" };
  }
  if (u.protocol !== "https:") return { ok: false, error: "The logo must be served over https." };
  if (u.username || u.password) return { ok: false, error: "The logo address must not contain a user name or password." };
  if (u.port && u.port !== "443") return { ok: false, error: "The logo must be on the standard https port." };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (/^[\d.]+$/.test(host) || host.includes(":")) return { ok: false, error: "Use the logo's web address (a domain name), not an IP address." };
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".internal") || host === "localhost") return { ok: false, error: "The logo must be on a public website." };
  u.hash = "";
  return { ok: true, url: u.toString() };
}

/** WCAG relative luminance of a "#RRGGBB" colour. */
export function relativeLuminance(hex: string): number {
  const n = normalizeBrandColor(hex);
  if (!n) return 0;
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** White or black, whichever reads better on the background. */
export function textColorOn(background: string): "#FFFFFF" | "#000000" {
  return contrastRatio(background, "#FFFFFF") >= contrastRatio(background, "#000000") ? "#FFFFFF" : "#000000";
}

export interface Branding {
  /** Header background. */
  color: string;
  /** Header text, chosen for contrast. */
  text: "#FFFFFF" | "#000000";
  /** Secondary header text (eyebrow line). The A3 default keeps its light-blue tint; a dealership colour uses the contrast colour itself, since a tint cannot be guaranteed readable on an arbitrary background. */
  subtle: string;
  logoUrl: string | null;
  /** True when the dealership supplied a colour or logo. */
  custom: boolean;
}

/** The branding to render, with A3 styling as the fallback for anything missing or invalid. */
export function resolveBranding(d: { brandColor?: string | null; logoUrl?: string | null } | null | undefined): Branding {
  const color = normalizeBrandColor(d?.brandColor) ?? A3_BRAND_COLOR;
  const shape = d?.logoUrl ? checkLogoUrlShape(d.logoUrl) : null;
  const logoUrl = shape?.ok ? shape.url : null;
  const text = textColorOn(color);
  return { color, text, subtle: color === A3_BRAND_COLOR ? "#93C5FD" : text, logoUrl, custom: color !== A3_BRAND_COLOR || logoUrl !== null };
}
