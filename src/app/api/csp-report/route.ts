import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { checkRateLimit, clientIp } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Browsers POST here when the Content-Security-Policy blocks something on a page.
 * Each report becomes a warning in System → logs, so a policy that breaks a real
 * page is noticed. Public (browsers send no session), size-capped and rate limited.
 */
export async function POST(request: Request) {
  const limit = await checkRateLimit({ key: `csp-report:${clientIp(request.headers)}`, limit: 20, windowSeconds: 3600 });
  if (!limit.allowed) return new NextResponse(null, { status: 204 });
  const raw = (await request.text()).slice(0, 8_000);
  let report: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as { "csp-report"?: Record<string, unknown> } | Array<{ body?: Record<string, unknown> }>;
    report = Array.isArray(parsed) ? (parsed[0]?.body ?? {}) : (parsed["csp-report"] ?? {});
  } catch {
    return new NextResponse(null, { status: 204 });
  }
  const pick = (...keys: string[]) => {
    for (const k of keys) if (typeof report[k] === "string") return String(report[k]).slice(0, 300);
    return null;
  };
  await logger.warn("security", "Content-Security-Policy blocked something on a page", {
    page: pick("document-uri", "documentURL"),
    directive: pick("violated-directive", "effectiveDirective", "effective-directive"),
    blocked: pick("blocked-uri", "blockedURL"),
    source: pick("source-file", "sourceFile"),
  });
  return new NextResponse(null, { status: 204 });
}
