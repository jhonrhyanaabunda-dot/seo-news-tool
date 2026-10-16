/**
 * Issue workflow: what staff have decided about an issue (open, in progress,
 * fixed, ignored), and what later scans say about that decision.
 *
 * Pure module (no database or environment). The rules here are tracking only:
 * the SEO score is computed from what a scan finds and never reads workflow
 * state, so marking an issue fixed or ignored cannot move the score — only a
 * scan that no longer finds the problem can. Ignored issues are still counted
 * in the score; they are only left out of "what to do next" lists.
 */
import { ISSUE_WORKFLOW_STATUSES, type IssueWorkflowStatus } from "@/lib/db/schema";

export { ISSUE_WORKFLOW_STATUSES, type IssueWorkflowStatus };

export const WORKFLOW_LABEL: Record<IssueWorkflowStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  fixed: "Marked fixed",
  ignored: "Ignored",
};

/** Filter values on the issues view. "reopened" is an indicator, not a stored status. */
export const WORKFLOW_FILTERS = ["open", "in_progress", "fixed", "ignored", "reopened"] as const;
export type WorkflowFilter = (typeof WORKFLOW_FILTERS)[number];

export function parseWorkflowFilter(v: string | undefined | null): WorkflowFilter | null {
  return v && (WORKFLOW_FILTERS as readonly string[]).includes(v) ? (v as WorkflowFilter) : null;
}

export function isWorkflowStatus(v: unknown): v is IssueWorkflowStatus {
  return typeof v === "string" && (ISSUE_WORKFLOW_STATUSES as readonly string[]).includes(v);
}

export const MAX_NOTE_LENGTH = 1000;

export interface WorkflowStateLike {
  status: IssueWorkflowStatus;
  fixedMarkedAt: Date | null;
  verifiedAt: Date | null;
  reopenedAt: Date | null;
}

/**
 * "Came back": a scan found the issue again after someone marked it fixed, and
 * nobody has re-decided since. Marking it fixed again (a newer fixed_marked_at)
 * clears the indicator; so does any other explicit status change, which resets
 * `reopenedAt` (see `applyStatusChange`).
 */
export function cameBack(s: Pick<WorkflowStateLike, "reopenedAt" | "fixedMarkedAt"> | null | undefined): boolean {
  if (!s?.reopenedAt) return false;
  return !s.fixedMarkedAt || s.reopenedAt.getTime() > s.fixedMarkedAt.getTime();
}

/** How a state reads to a person: the stored status plus what the scans said about it. */
export function describeState(s: WorkflowStateLike | null | undefined): { label: string; tone: "neutral" | "info" | "success" | "warning" | "critical" | "accent"; detail: string | null } {
  if (!s || s.status === "open") {
    return cameBack(s) ? { label: "Came back", tone: "critical", detail: "Marked fixed, but a later scan still found it." } : { label: "Open", tone: "neutral", detail: null };
  }
  if (s.status === "in_progress") return { label: "In progress", tone: "accent", detail: null };
  if (s.status === "ignored") return { label: "Ignored", tone: "neutral", detail: "Still counted in the score." };
  if (s.verifiedAt) return { label: "Fixed · verified", tone: "success", detail: "A later full scan checked the page and no longer found it." };
  return { label: "Marked fixed", tone: "info", detail: "Awaiting the next full scan to confirm." };
}

/**
 * The timestamps a manual status change writes. Marking fixed starts a new
 * verification (clears any earlier verification); any explicit decision clears
 * the "came back" indicator because a person has now looked at it again.
 */
export function applyStatusChange(next: IssueWorkflowStatus, now: Date): Pick<WorkflowStateLike, "fixedMarkedAt" | "verifiedAt" | "reopenedAt"> & { status: IssueWorkflowStatus } {
  if (next === "fixed") return { status: next, fixedMarkedAt: now, verifiedAt: null, reopenedAt: null };
  return { status: next, fixedMarkedAt: null, verifiedAt: null, reopenedAt: null };
}

export interface ScanEvidence {
  /** Fingerprints of every issue the scan found. */
  found: Set<string>;
  /**
   * True when the scan read the whole site normally (full audit, site up, not
   * blocked or partially blocked). Only such a scan may *verify* a fix; any
   * scan that finds the issue is evidence enough to reopen it.
   */
  fullScan: boolean;
  /** urlKey() of every page the scan actually evaluated. */
  evaluatedUrlKeys: Set<string>;
  /** urlKey() of the homepage, for site-level checks (robots.txt, sitemap…). */
  siteEvaluated: boolean;
}

export interface ReconcileInput {
  fingerprint: string;
  url: string;
  status: IssueWorkflowStatus;
  verifiedAt: Date | null;
  /** True for checks whose scope is the whole site rather than one page. */
  siteScope: boolean;
}

export type ReconcileAction = { fingerprint: string; action: "verify" } | { fingerprint: string; action: "reopen" };

/**
 * After a scan: confirm or contradict every issue marked fixed.
 *
 *  - still found        → reopen (status back to open, "came back" indicator).
 *  - not found, and the page was evaluated in a full scan → verify.
 *  - not found, but the page was not evaluated (blocked, not crawled this
 *    time, partial scan) → no change. Absence of evidence is not a fix.
 *
 * Only `fixed` states are considered; open / in-progress / ignored issues are
 * left exactly as staff set them.
 */
export function reconcileFixedStates(states: ReconcileInput[], scan: ScanEvidence, urlKey: (url: string) => string): ReconcileAction[] {
  const out: ReconcileAction[] = [];
  for (const s of states) {
    if (s.status !== "fixed") continue;
    if (scan.found.has(s.fingerprint)) {
      out.push({ fingerprint: s.fingerprint, action: "reopen" });
      continue;
    }
    if (s.verifiedAt || !scan.fullScan) continue;
    const evaluated = s.siteScope ? scan.siteEvaluated : scan.evaluatedUrlKeys.has(urlKey(s.url));
    if (evaluated) out.push({ fingerprint: s.fingerprint, action: "verify" });
  }
  return out;
}

/**
 * Which opportunities belong in a "what to do next" list. An opportunity whose
 * every finding is ignored is left out; one with some findings ignored stays
 * (the rest still need doing). Counts are untouched — they are facts.
 */
export function isActionable(o: { findings: number }, ignoredFindings: number): boolean {
  return ignoredFindings < o.findings;
}
