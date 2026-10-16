/**
 * The database-free half of the audit trail: what actions exist, how details
 * are scrubbed before they are stored, and how the Audit log page reads its
 * filters. Kept apart from `audit.ts` so it is unit-tested without Postgres.
 */

/** Every action string written to `audit_logs`, with the label the Audit log page shows. */
export const AUDIT_ACTIONS = {
  "auth.sign_in": "Signed in",
  "auth.sign_in_failed": "Sign-in failed",
  "auth.mfa_failed": "Two-factor code rejected",
  "auth.recovery_code_used": "Signed in with a recovery code",
  "auth.sign_out": "Signed out",
  "auth.password_changed": "Changed own password",
  "auth.password_reset_completed": "Reset password by email link",
  "mfa.enabled": "Turned on two-factor",
  "mfa.disabled": "Turned off two-factor",
  "mfa.recovery_regenerated": "Generated new recovery codes",
  "mfa.reset_by_admin": "Reset another user's two-factor",
  "user.create": "Created user",
  "user.edit": "Edited user",
  "user.delete": "Deleted user",
  "user.role": "Changed user role",
  "user.activate": "Activated user",
  "user.deactivate": "Deactivated user",
  "user.password_reset": "Reset user's password",
  "user.dealership_access": "Changed dealership access",
  "dealership.create": "Created dealership",
  "dealership.update": "Edited dealership",
  "dealership.delete": "Deleted dealership",
  "dealership.scan_now": "Started an SEO scan",
  "dealership.news_scan_now": "Started a news check",
  "dealership.scan_cancel": "Cancelled a scan",
  "keyword.add": "Added keyword",
  "keyword.remove": "Removed keyword",
  "news_source.add": "Added news source",
  "news_source.remove": "Removed news source",
  "seo_feed.add": "Added SEO news feed",
  "seo_feed.toggle": "Turned SEO news feed on/off",
  "seo_feed.remove": "Removed SEO news feed",
  "seo_feed.fetch_now": "Fetched SEO news now",
  "settings.update": "Updated settings",
  "settings.test_email": "Sent a test email",
  "settings.newsletter_preview": "Sent a newsletter preview",
  "system.process_queue": "Started queue processing",
  "system.retry_job": "Retried a failed job",
  "report.generate": "Generated a report",
  "report.email": "Emailed a report",
  "report.pdf": "Requested a report PDF",
  "competitor.add": "Added competitor",
  "competitor.remove": "Removed competitor",
  "integrations.sync_now": "Synced Search Console / Google listing now",
} as const;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

export function auditActionLabel(action: string): string {
  return (AUDIT_ACTIONS as Record<string, string>)[action] ?? action;
}

/** Keys whose values are never stored, at any depth, whatever the caller passes. */
const secretKey = (k: string) =>
  /password|passwd|secret|token|cookie|authorization|credential|apikey|privatekey/i.test(k.replace(/[_-]/g, "")) || /^(t?otp|code|codes|key|hash|recoverycodes?|pass)$/i.test(k.replace(/[_-]/g, ""));
const MAX_STRING = 500;
const MAX_DEPTH = 4;
const MAX_KEYS = 40;

/**
 * Make details safe and small: secret-looking keys are replaced with
 * "[redacted]", strings are truncated, depth and width are capped, and anything
 * not JSON-shaped (functions, errors, dates) is reduced to a string.
 */
export function sanitizeAuditDetails(details: Record<string, unknown> | undefined | null): Record<string, unknown> | null {
  if (!details) return null;
  const walk = (v: unknown, depth: number): unknown => {
    if (v === null || v === undefined) return v ?? null;
    if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…` : v;
    if (typeof v === "number" || typeof v === "boolean") return v;
    if (v instanceof Date) return v.toISOString();
    if (v instanceof Error) return v.message.slice(0, MAX_STRING);
    if (depth >= MAX_DEPTH) return "[truncated]";
    if (Array.isArray(v)) return v.slice(0, MAX_KEYS).map((x) => walk(x, depth + 1));
    if (typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, MAX_KEYS)) {
        out[k] = secretKey(k) ? "[redacted]" : walk(val, depth + 1);
      }
      return out;
    }
    return String(v).slice(0, MAX_STRING);
  };
  return walk(details, 0) as Record<string, unknown>;
}

/** Names of the settings that changed between two snapshots (values are not logged: they may hold addresses). */
export function changedKeys(before: Record<string, unknown>, after: Record<string, unknown>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
}

/** Audit rows are kept this long by maintenance: longer than operational logs, since they answer "who did this?". */
export const AUDIT_RETENTION_DAYS = 365;

export const AUDIT_PAGE_SIZE = 50;

export type AuditFilters = { page: number; action?: string; actor?: number };

/** Read the page's query string; anything unrecognised is dropped rather than queried. */
export function parseAuditFilters(sp: { page?: string; action?: string; actor?: string }): AuditFilters {
  const page = Math.min(10_000, Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1));
  const action = sp.action && Object.hasOwn(AUDIT_ACTIONS, sp.action) ? sp.action : undefined;
  const actorN = Number.parseInt(sp.actor ?? "", 10);
  const actor = Number.isInteger(actorN) && actorN > 0 ? actorN : undefined;
  return { page, action, actor };
}

/** The query string for a filter set (page 1 and empty filters are left out). */
export function auditHref(f: AuditFilters): string {
  const p = new URLSearchParams();
  if (f.action) p.set("action", f.action);
  if (f.actor) p.set("actor", String(f.actor));
  if (f.page > 1) p.set("page", String(f.page));
  const qs = p.toString();
  return `/admin/audit${qs ? `?${qs}` : ""}`;
}
