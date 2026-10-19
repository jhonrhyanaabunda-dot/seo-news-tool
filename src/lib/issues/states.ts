import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { issueStates, scanPages, seoIssues, seoScans, users, type IssueState, type IssueWorkflowStatus } from "@/lib/db/schema";
import { CHECKS_BY_KEY } from "@/lib/seo/checks/config";
import { urlKey } from "@/lib/seo/checks/evaluate";
import { classifyPageResult, isAnalyzed } from "@/lib/seo/result-class";
import { applyStatusChange, reconcileFixedStates, type ReconcileAction } from "./workflow";

/**
 * Reading and writing issue workflow state. Authorisation is decided by the
 * caller (the server action); everything here is scoped by dealership, so a
 * fingerprint alone never reaches another dealership's rows.
 */

/** Workflow state for these fingerprints of one dealership, keyed by fingerprint. */
export async function getIssueStates(dealershipId: number, fingerprints: string[]): Promise<Map<string, IssueState>> {
  const unique = [...new Set(fingerprints)];
  if (!unique.length) return new Map();
  const rows: IssueState[] = [];
  for (let k = 0; k < unique.length; k += 500) {
    rows.push(...(await db.select().from(issueStates).where(and(eq(issueStates.dealershipId, dealershipId), inArray(issueStates.fingerprint, unique.slice(k, k + 500))))));
  }
  return new Map(rows.map((r) => [r.fingerprint, r]));
}

/** Per check, how many of this scan's findings carry each workflow status (no row = open). */
export async function getWorkflowCountsByCheck(scanId: number): Promise<Map<string, Partial<Record<IssueWorkflowStatus, number>>>> {
  const rows = await db
    .select({ checkKey: seoIssues.checkKey, status: issueStates.status, n: sql<number>`count(*)::int` })
    .from(seoIssues)
    .innerJoin(issueStates, and(eq(issueStates.dealershipId, seoIssues.dealershipId), eq(issueStates.fingerprint, seoIssues.fingerprint)))
    .where(eq(seoIssues.scanId, scanId))
    .groupBy(seoIssues.checkKey, issueStates.status);
  const out = new Map<string, Partial<Record<IssueWorkflowStatus, number>>>();
  for (const r of rows) out.set(r.checkKey, { ...(out.get(r.checkKey) ?? {}), [r.status]: Number(r.n) });
  return out;
}

/** Staff who may be assigned an issue (A3 staff, never a dealership login). */
export async function getAssignableUsers(): Promise<Array<{ id: number; name: string }>> {
  return db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.isActive, true), inArray(users.role, ["admin", "viewer"])))
    .orderBy(users.name);
}

export async function isAssignableUser(id: number): Promise<boolean> {
  const [u] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, id), eq(users.isActive, true), inArray(users.role, ["admin", "viewer"]))).limit(1);
  return Boolean(u);
}

/**
 * The issues a workflow change applies to, resolved from the dealership's own
 * scan rows: one fingerprint, or every finding of one check in a scan. Anything
 * not found there for this dealership is silently not a target.
 */
export async function resolveTargets(dealershipId: number, scanId: number, by: { fingerprint?: string; checkKey?: string }): Promise<Array<{ fingerprint: string; checkKey: string; url: string }>> {
  const where = [eq(seoIssues.dealershipId, dealershipId), eq(seoIssues.scanId, scanId)];
  if (by.fingerprint) where.push(eq(seoIssues.fingerprint, by.fingerprint));
  else if (by.checkKey) where.push(eq(seoIssues.checkKey, by.checkKey));
  else return [];
  const rows = await db.select({ fingerprint: seoIssues.fingerprint, checkKey: seoIssues.checkKey, url: seoIssues.url }).from(seoIssues).where(and(...where)).limit(2000);
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.fingerprint) ? false : (seen.add(r.fingerprint), true)));
}

export async function setIssueStates(input: {
  dealershipId: number;
  targets: Array<{ fingerprint: string; checkKey: string; url: string }>;
  status: IssueWorkflowStatus;
  note: string | null;
  assignedTo: number | null;
  by: number;
}): Promise<number> {
  if (!input.targets.length) return 0;
  const now = new Date();
  const change = applyStatusChange(input.status, now);
  const values = input.targets.map((t) => ({
    dealershipId: input.dealershipId,
    fingerprint: t.fingerprint,
    checkKey: t.checkKey,
    url: t.url.slice(0, 2000),
    ...change,
    note: input.note,
    assignedTo: input.assignedTo,
    updatedBy: input.by,
    updatedAt: now,
  }));
  for (let k = 0; k < values.length; k += 500) {
    await db
      .insert(issueStates)
      .values(values.slice(k, k + 500))
      .onConflictDoUpdate({
        target: [issueStates.dealershipId, issueStates.fingerprint],
        set: {
          status: sql`excluded.status`,
          note: sql`excluded.note`,
          assignedTo: sql`excluded.assigned_to`,
          updatedBy: sql`excluded.updated_by`,
          updatedAt: sql`excluded.updated_at`,
          // Re-saving the same status (say, to edit the note) keeps its history:
          // a fix stays verified, a "came back" stays visible until re-decided.
          fixedMarkedAt: sql`case when ${issueStates.status} = excluded.status then ${issueStates.fixedMarkedAt} else excluded.fixed_marked_at end`,
          verifiedAt: sql`case when ${issueStates.status} = excluded.status then ${issueStates.verifiedAt} else excluded.verified_at end`,
          reopenedAt: sql`case when ${issueStates.status} = excluded.status then ${issueStates.reopenedAt} else excluded.reopened_at end`,
        },
      });
  }
  return values.length;
}

/**
 * After a scan completes: verify fixes the scan confirms, reopen fixes it
 * contradicts (see `reconcileFixedStates`). Returns what changed.
 */
export async function reconcileIssueStatesAfterScan(scanId: number): Promise<{ verified: number; reopened: number }> {
  const [scan] = await db.select().from(seoScans).where(eq(seoScans.id, scanId)).limit(1);
  if (!scan || scan.status !== "completed") return { verified: 0, reopened: 0 };
  const fixed = await db.select().from(issueStates).where(and(eq(issueStates.dealershipId, scan.dealershipId), eq(issueStates.status, "fixed")));
  if (!fixed.length) return { verified: 0, reopened: 0 };

  const found = new Set((await db.select({ fingerprint: seoIssues.fingerprint }).from(seoIssues).where(eq(seoIssues.scanId, scan.id))).map((r) => r.fingerprint));
  const pages = await db
    .select({ url: scanPages.url, finalUrl: scanPages.finalUrl, status: scanPages.status, httpStatus: scanPages.httpStatus, errorCode: scanPages.errorCode, errorMessage: scanPages.errorMessage, redirected: scanPages.redirected, resultClass: scanPages.resultClass })
    .from(scanPages)
    .where(eq(scanPages.scanId, scan.id));
  const evaluatedUrlKeys = new Set<string>();
  for (const p of pages) {
    if (!isAnalyzed(p.resultClass ?? classifyPageResult(p))) continue;
    evaluatedUrlKeys.add(urlKey(p.url));
    if (p.finalUrl) evaluatedUrlKeys.add(urlKey(p.finalUrl));
  }
  const fullScan = scan.siteAvailable === true && (scan.siteChecks?.auditMode ?? "full") === "full" && scan.outcome !== "blocked" && scan.outcome !== "partially_blocked";
  const actions: ReconcileAction[] = reconcileFixedStates(
    fixed.map((s) => ({ fingerprint: s.fingerprint, url: s.url, status: s.status, verifiedAt: s.verifiedAt, siteScope: CHECKS_BY_KEY[s.checkKey]?.scope === "site" })),
    { found, fullScan, evaluatedUrlKeys, siteEvaluated: fullScan && evaluatedUrlKeys.size > 0 },
    urlKey,
  );
  const now = new Date();
  const verify = actions.filter((a) => a.action === "verify").map((a) => a.fingerprint);
  const reopen = actions.filter((a) => a.action === "reopen").map((a) => a.fingerprint);
  for (let k = 0; k < verify.length; k += 500) {
    await db.update(issueStates).set({ verifiedAt: now }).where(and(eq(issueStates.dealershipId, scan.dealershipId), eq(issueStates.status, "fixed"), inArray(issueStates.fingerprint, verify.slice(k, k + 500))));
  }
  for (let k = 0; k < reopen.length; k += 500) {
    // Back to open, keeping fixed_marked_at so "came back after being marked fixed" can be shown.
    await db
      .update(issueStates)
      .set({ status: "open", verifiedAt: null, reopenedAt: now, updatedAt: now })
      .where(and(eq(issueStates.dealershipId, scan.dealershipId), eq(issueStates.status, "fixed"), inArray(issueStates.fingerprint, reopen.slice(k, k + 500))));
  }
  return { verified: verify.length, reopened: reopen.length };
}
