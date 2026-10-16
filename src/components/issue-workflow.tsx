import type { IssueState } from "@/lib/db/schema";
import { ISSUE_WORKFLOW_STATUSES, MAX_NOTE_LENGTH, WORKFLOW_LABEL, cameBack, describeState } from "@/lib/issues/workflow";
import { updateIssueStateAction } from "@/app/actions/issues";
import { SubmitButton } from "@/components/client/submit-button";
import { Badge } from "@/components/ui";

/**
 * Issue workflow UI: a status badge everyone sees, and (admins only) a small
 * form behind a disclosure to change it. Server-rendered, works without JS.
 */

export function IssueStatusBadge({ state }: { state: IssueState | null | undefined }) {
  const d = describeState(state);
  return (
    <span title={d.detail ?? undefined}>
      <Badge tone={d.tone} dot={cameBack(state)}>
        {d.label}
      </Badge>
    </span>
  );
}

/** The plain-language rule, shown wherever statuses are. */
export function WorkflowScoreNote({ className }: { className?: string }) {
  return (
    <p className={className ?? "text-xs text-slate-500"}>
      Status is for tracking work only. The SEO score is calculated by fixed rules from what each scan finds, so marking an issue fixed or ignored never changes it — ignored issues
      still count. A fix is <strong>verified</strong> when a later full scan checks the page and no longer finds the problem; if the scan still finds it, it is reopened as{" "}
      <strong>came back</strong>.
    </p>
  );
}

export function IssueWorkflowEditor({
  dealershipId,
  fingerprint,
  checkKey,
  state,
  assignees,
  back,
  summary = "Update status",
}: {
  dealershipId: number;
  fingerprint?: string;
  checkKey?: string;
  state: IssueState | null | undefined;
  assignees: Array<{ id: number; name: string }>;
  /** Where to return after saving (same dealership page, with filters). */
  back: string;
  summary?: string;
}) {
  const uid = `${fingerprint ?? checkKey ?? "x"}`.slice(0, 16);
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:underline">{summary}</summary>
      <form action={updateIssueStateAction} className="mt-2 w-56 space-y-2 rounded-md border border-slate-200 bg-white p-2.5">
        <input type="hidden" name="id" value={dealershipId} />
        {fingerprint ? <input type="hidden" name="fingerprint" value={fingerprint} /> : <input type="hidden" name="checkKey" value={checkKey} />}
        <input type="hidden" name="back" value={back} />
        <div>
          <label htmlFor={`st-${uid}`} className="label !text-xs">
            Status
          </label>
          <select id={`st-${uid}`} name="status" defaultValue={state?.status ?? "open"} className="input !py-1 !text-sm">
            {ISSUE_WORKFLOW_STATUSES.map((s) => (
              <option key={s} value={s}>
                {WORKFLOW_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`as-${uid}`} className="label !text-xs">
            Assigned to
          </label>
          <select id={`as-${uid}`} name="assignedTo" defaultValue={state?.assignedTo ? String(state.assignedTo) : ""} className="input !py-1 !text-sm">
            <option value="">Nobody</option>
            {assignees.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor={`nt-${uid}`} className="label !text-xs">
            Note (staff only)
          </label>
          <textarea id={`nt-${uid}`} name="note" rows={2} maxLength={MAX_NOTE_LENGTH} defaultValue={state?.note ?? ""} className="input !text-sm" />
        </div>
        <SubmitButton className="btn btn-sm w-full" pendingText="Saving…">
          Save
        </SubmitButton>
      </form>
    </details>
  );
}
