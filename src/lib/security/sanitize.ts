/** Small, dependency-free helpers for safely handling user/website supplied strings. */

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;

/** Collapse whitespace and strip control characters; truncate to a max length. */
export function cleanText(input: unknown, max = 1000): string {
  if (typeof input !== "string") return "";
  return input.replace(CONTROL_CHARS, "").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Escape for inclusion in HTML (emails, server-rendered strings). */
export function escapeHtml(input: string): string {
  return input.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Parse a comma/newline separated list of email addresses, dropping invalid ones. */
export function parseEmailList(input: string): { valid: string[]; invalid: string[] } {
  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(/[,\n;]+/)) {
    const e = raw.trim().toLowerCase();
    if (!e) continue;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 320) {
      if (!seen.has(e)) {
        seen.add(e);
        valid.push(e);
      }
    } else invalid.push(raw.trim());
  }
  return { valid, invalid };
}
