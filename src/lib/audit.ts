import "server-only";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { auditLogs } from "@/lib/db/schema";
import { clientIp } from "@/lib/security/rate-limit";
import { sanitizeAuditDetails, type AuditAction } from "./audit-shared";

export { AUDIT_RETENTION_DAYS, changedKeys } from "./audit-shared";

export type AuditInput = {
  /** Who acted. Null for an anonymous attempt (e.g. a failed sign-in for an unknown address). */
  actor: { id: number; email: string } | null;
  /** Snapshot of the address typed when there is no account to name. */
  actorEmail?: string;
  action: AuditAction;
  target?: { type: string; id?: string | number | null };
  summary: string;
  /** Context only — never passwords, tokens, secrets or codes. Scrubbed again regardless. */
  details?: Record<string, unknown>;
};

/**
 * Append one row to the audit trail.
 *
 * Never throws: an audit write failing (database hiccup, called outside a
 * request) must not undo or break the change it describes, so failures go to
 * stderr instead. IP and user agent come from the current request when there
 * is one.
 */
export async function recordAudit(entry: AuditInput): Promise<void> {
  try {
    let ip: string | null = null;
    let userAgent: string | null = null;
    try {
      const h = await headers();
      ip = clientIp(h);
      userAgent = h.get("user-agent")?.slice(0, 500) ?? null;
    } catch {
      // Not inside a request (job, script): there is no client to record.
    }
    await db.insert(auditLogs).values({
      actorUserId: entry.actor?.id ?? null,
      actorEmail: (entry.actor?.email ?? entry.actorEmail ?? null)?.slice(0, 320) ?? null,
      action: entry.action,
      targetType: entry.target?.type.slice(0, 40) ?? null,
      targetId: entry.target?.id === undefined || entry.target?.id === null ? null : String(entry.target.id).slice(0, 64),
      summary: entry.summary.slice(0, 1000),
      details: sanitizeAuditDetails(entry.details),
      ip,
      userAgent,
    });
  } catch (err) {
    console.error(JSON.stringify({ ts: new Date().toISOString(), level: "error", source: "audit", message: "Failed to record audit entry", action: entry.action, error: err instanceof Error ? err.message : String(err) }));
  }
}
