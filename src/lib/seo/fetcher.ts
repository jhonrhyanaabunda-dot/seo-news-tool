import "server-only";
import { env } from "@/lib/env";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/security/ssrf";
import { isSameSite } from "./url";
import { isRetryable } from "./crawl-policy";
import { detectBlock } from "./block-detect";

export type FetchErrorCode =
  | "TIMEOUT"
  | "DNS"
  | "CONNECTION"
  | "TLS"
  | "TOO_LARGE"
  | "UNSAFE_URL"
  | "NOT_HTML"
  | "TOO_MANY_REDIRECTS"
  | "REDIRECT_OFFSITE"
  | "UNKNOWN";

export interface FetchResult {
  ok: boolean;
  status: number | null;
  finalUrl: string;
  redirected: boolean;
  redirectChain: string[];
  headers: Record<string, string>;
  contentType: string | null;
  body: string | null;
  bytes: number;
  truncated: boolean;
  ttfbMs: number;
  totalMs: number;
  errorCode: FetchErrorCode | null;
  errorMessage: string | null;
  /** How the HTML was obtained. "browser" means Chromium rendered it after a plain request was refused. */
  fetchMethod?: "http" | "browser";
  /**
   * Time the *server* took to deliver the document, excluding browser startup,
   * JavaScript execution and challenge waits. Set only for browser fetches,
   * where `totalMs` measures rendering rather than server performance and would
   * badly overstate response time. Falls back to `totalMs` when absent.
   */
  serverResponseMs?: number | null;
}

export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  /** When true, only HTML responses are read; others are discarded after headers. */
  htmlOnly?: boolean;
  /** Don't read the body at all (link checks). */
  headersOnly?: boolean;
  /** Keep redirects on the same site (page crawls). */
  sameSiteOnly?: boolean;
  retries?: number;
  accept?: string;
  /** Extra request headers, e.g. If-None-Match / If-Modified-Since for conditional feed requests. */
  headers?: Record<string, string>;
}

const DEFAULTS: Required<Omit<FetchOptions, "accept" | "headers">> = {
  timeoutMs: 15000,
  maxBytes: 3 * 1024 * 1024,
  maxRedirects: 5,
  htmlOnly: false,
  headersOnly: false,
  sameSiteOnly: false,
  retries: 1,
};

function classifyError(err: unknown): { code: FetchErrorCode; message: string } {
  const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string; message?: string } };
  const cause = e?.cause?.code ?? e?.code ?? "";
  if (e?.name === "AbortError" || e?.name === "TimeoutError" || cause === "UND_ERR_HEADERS_TIMEOUT" || cause === "UND_ERR_BODY_TIMEOUT")
    return { code: "TIMEOUT", message: "Request timed out" };
  if (cause === "ENOTFOUND" || cause === "EAI_AGAIN") return { code: "DNS", message: "DNS lookup failed" };
  if (/CERT|SSL|TLS|self.signed|unable to verify/i.test(cause + " " + (e?.cause?.message ?? "") + " " + (e?.message ?? "")))
    return { code: "TLS", message: "TLS certificate error" };
  if (cause === "ECONNREFUSED" || cause === "ECONNRESET" || cause === "EHOSTUNREACH" || cause === "ENETUNREACH" || cause === "EPIPE" || cause === "UND_ERR_SOCKET")
    return { code: "CONNECTION", message: `Connection failed (${cause})` };
  return { code: "UNKNOWN", message: e?.message ?? "Unknown fetch error" };
}

async function readBodyLimited(res: Response, maxBytes: number, signal: AbortSignal): Promise<{ text: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { text: "", bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    while (true) {
      if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        received += value.byteLength;
        if (received > maxBytes) {
          chunks.push(value.subarray(0, value.byteLength - (received - maxBytes)));
          truncated = true;
          break;
        }
        chunks.push(value);
      }
    }
  } finally {
    if (truncated) reader.cancel().catch(() => {});
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const charset = /charset=([\w-]+)/i.exec(res.headers.get("content-type") ?? "")?.[1]?.toLowerCase();
  let text: string;
  try {
    text = new TextDecoder(charset && charset !== "utf8" ? charset : "utf-8", { fatal: false }).decode(buf);
  } catch {
    text = buf.toString("utf8");
  }
  return { text, bytes: Math.min(received, maxBytes), truncated };
}

/**
 * Fetch a URL safely:
 *  - SSRF validation on the initial URL and on every redirect hop
 *  - manual redirect handling (bounded)
 *  - hard timeout, response size cap, HTML-only mode
 *  - one retry for transient failures (network errors, 5xx, 429)
 */
export async function safeFetch(inputUrl: string, options: FetchOptions = {}): Promise<FetchResult> {
  const merged = { ...DEFAULTS, ...options };
  // MAX_RETRIES / CRAWLER_MAX_RETRIES caps every caller's retry count.
  const opts = { ...merged, retries: Math.min(merged.retries, env().CRAWLER_MAX_RETRIES), timeoutMs: options.timeoutMs ?? env().CRAWLER_TIMEOUT_MS };
  let attempt = 0;
  let last: FetchResult | null = null;
  while (attempt <= opts.retries) {
    last = await fetchOnce(inputUrl, opts);
    // Never retry refusals (401/403/429/challenge pages): repeating them can trigger more protection.
    const blocked = last.body !== null && detectBlock(last).blocked;
    if (!isRetryable(last.status, last.errorCode, blocked) || attempt === opts.retries) return last;
    attempt++;
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
  return last!;
}

async function fetchOnce(inputUrl: string, opts: Required<Omit<FetchOptions, "accept" | "headers">> & { accept?: string; headers?: Record<string, string> }): Promise<FetchResult> {
  const started = performance.now();
  const chain: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  const base: FetchResult = {
    ok: false,
    status: null,
    finalUrl: inputUrl,
    redirected: false,
    redirectChain: chain,
    headers: {},
    contentType: null,
    body: null,
    bytes: 0,
    truncated: false,
    ttfbMs: 0,
    totalMs: 0,
    errorCode: null,
    errorMessage: null,
    fetchMethod: "http",
  };
  const finish = (partial: Partial<FetchResult>): FetchResult => ({ ...base, ...partial, totalMs: Math.round(performance.now() - started) });

  try {
    let current: URL;
    try {
      current = (await assertSafeUrl(inputUrl)).url;
    } catch (err) {
      return finish({ errorCode: "UNSAFE_URL", errorMessage: err instanceof Error ? err.message : "Unsafe URL" });
    }
    const origin = new URL(inputUrl);

    for (let hop = 0; hop <= opts.maxRedirects; hop++) {
      const res = await fetch(current.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": env().CRAWLER_USER_AGENT,
          Accept: opts.accept ?? "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          ...opts.headers,
        },
      });
      const ttfbMs = Math.round(performance.now() - started);
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => (headers[k] = v));

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        res.body?.cancel().catch(() => {});
        let next: URL;
        try {
          next = new URL(res.headers.get("location")!, current);
          next = (await assertSafeUrl(next)).url;
        } catch (err) {
          return finish({
            status: res.status,
            headers,
            ttfbMs,
            finalUrl: current.toString(),
            redirected: chain.length > 0,
            errorCode: "UNSAFE_URL",
            errorMessage: err instanceof UnsafeUrlError ? err.message : "Invalid redirect target",
          });
        }
        chain.push(current.toString());
        if (opts.sameSiteOnly && !isSameSite(origin, next)) {
          return finish({ status: res.status, headers, ttfbMs, finalUrl: next.toString(), redirected: true, errorCode: "REDIRECT_OFFSITE", errorMessage: `Redirects to ${next.hostname}` });
        }
        current = next;
        if (hop === opts.maxRedirects) {
          return finish({ status: res.status, headers, ttfbMs, finalUrl: current.toString(), redirected: true, errorCode: "TOO_MANY_REDIRECTS", errorMessage: "Too many redirects" });
        }
        continue;
      }

      const contentType = res.headers.get("content-type");
      const isHtml = !contentType || /text\/html|application\/xhtml\+xml/i.test(contentType);
      if (opts.headersOnly || (opts.htmlOnly && !isHtml)) {
        res.body?.cancel().catch(() => {});
        return finish({
          ok: res.ok,
          status: res.status,
          headers,
          contentType,
          ttfbMs,
          finalUrl: current.toString(),
          redirected: chain.length > 0,
          errorCode: opts.htmlOnly && !isHtml ? "NOT_HTML" : null,
          errorMessage: opts.htmlOnly && !isHtml ? `Content type ${contentType}` : null,
        });
      }
      const { text, bytes, truncated } = await readBodyLimited(res, opts.maxBytes, controller.signal);
      return finish({
        ok: res.ok,
        status: res.status,
        headers,
        contentType,
        body: text,
        bytes,
        truncated,
        ttfbMs,
        finalUrl: current.toString(),
        redirected: chain.length > 0,
      });
    }
    return finish({ errorCode: "TOO_MANY_REDIRECTS", errorMessage: "Too many redirects" });
  } catch (err) {
    const { code, message } = classifyError(err);
    return finish({ errorCode: code, errorMessage: message });
  } finally {
    clearTimeout(timer);
  }
}
