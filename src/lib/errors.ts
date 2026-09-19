/** Error helpers with no dependencies (safe to import from tests and client-free code). */

/**
 * A dropped or unreachable database/network connection (laptop waking up, Wi-Fi change, idle socket closed).
 * These recover on the next run by themselves, so they are logged as warnings rather than errors.
 */
export function isTransientNetworkError(err: unknown): boolean {
  const parts: string[] = [];
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const x = e as { code?: unknown; message?: unknown; cause?: unknown };
    parts.push(String(x.code ?? ""), String(x.message ?? ""));
    e = x.cause;
  }
  return /ECONNRESET|ETIMEDOUT|CONNECT_TIMEOUT|EADDRNOTAVAIL|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN|ENOTFOUND|EPIPE|CONNECTION_(CLOSED|ENDED|DESTROYED)/.test(parts.join(" "));
}
