/**
 * Where a sign-in may send the browser afterwards.
 *
 * `?next=` is attacker-controllable: anyone can send a dealership a link to our
 * own login page carrying someone else's destination. The only safe answer is
 * an allow-list of shapes, not a block-list of bad ones, so this returns "/"
 * for anything it does not positively recognise as a path inside this app.
 *
 * The subtle case is the backslash. `startsWith("/") && !startsWith("//")`
 * looks sufficient but lets `/\evil.example` through, and browsers normalise a
 * `Location:` of `/\host` to the protocol-relative `//host` — an external
 * redirect. Backslashes are therefore rejected outright, before and after
 * decoding, since `%5C` is the same character once the browser unescapes it.
 */

/** Resolves to this when `next` is missing, malformed or points outside the app. */
export const DEFAULT_NEXT = "/";

export function safeNextPath(next: string | null | undefined): string {
  if (!next) return DEFAULT_NEXT;

  // Percent-encoding can hide a backslash or a control character from the
  // checks below, so inspect the decoded form too. A value that cannot be
  // decoded is malformed and not worth salvaging.
  let decoded = next;
  for (let i = 0; i < 3; i++) {
    try {
      const once = decodeURIComponent(decoded);
      if (once === decoded) break;
      decoded = once;
    } catch {
      return DEFAULT_NEXT;
    }
  }

  for (const value of [next, decoded]) {
    // Backslashes, whitespace and control characters are all browser
    // normalisation hazards; none belongs in a path we generated.
    if (/[\\]/.test(value)) return DEFAULT_NEXT;
    if (/[\u0000-\u001f\u007f\s]/.test(value)) return DEFAULT_NEXT;
    if (!value.startsWith("/")) return DEFAULT_NEXT; // absolute, scheme-relative or a bare word
    if (value.startsWith("//")) return DEFAULT_NEXT; // protocol-relative
  }

  // Belt and braces: resolve against a throwaway origin and keep the result
  // only if it stayed on that origin. This catches anything the string checks
  // above have not thought of.
  try {
    const url = new URL(decoded, "https://a3-seo-monitor.invalid");
    if (url.origin !== "https://a3-seo-monitor.invalid") return DEFAULT_NEXT;
    const resolved = `${url.pathname}${url.search}${url.hash}`;
    return resolved.startsWith("/") && !resolved.startsWith("//") ? resolved : DEFAULT_NEXT;
  } catch {
    return DEFAULT_NEXT;
  }
}
