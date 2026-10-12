/**
 * Naming and validating a rendered report. Pure module: no database, no
 * browser, so the rules that decide what may be streamed to a person can be
 * tested on their own.
 */

/** A real PDF starts with this; anything else must not reach a browser as one. */
export function looksLikePdf(bytes: Buffer): boolean {
  return bytes.length >= 5 && bytes.subarray(0, 5).toString("latin1") === "%PDF-";
}

/**
 * `BMW of Fort Walton Beach` → `BMW-of-Fort-Walton-Beach-SEO-Report-2026-10.pdf`
 *
 * The dealership name is attacker-adjacent data that ends up in a
 * `Content-Disposition` header and in a filename on someone's disk, so
 * everything outside letters and digits is collapsed to a hyphen. That removes
 * quotes, CR/LF, slashes and dots in one rule rather than by blocklist.
 */
export function reportFilename(dealershipName: string, period: Date): string {
  const safe = dealershipName
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  const month = `${period.getUTCFullYear()}-${String(period.getUTCMonth() + 1).padStart(2, "0")}`;
  return `${safe || "Dealership"}-SEO-Report-${month}.pdf`;
}
