"use client";

import { useState } from "react";
import { ISSUE_WORKFLOW_STATUSES, MAX_NOTE_LENGTH, WORKFLOW_LABEL } from "@/lib/issues/workflow";
import { updateIssueStateAction } from "@/app/actions/issues";
import { SubmitButton } from "@/components/client/submit-button";

/**
 * The form behind "Update status". A table can have fifty of these and most are
 * never opened, so the form exists only once its row is: this was most of the
 * size of the SEO issues page.
 */
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
  state: { status: string; assignedTo: number | null; note: string | null } | null | undefined;
  assignees: Array<{ id: number; name: string }>;
  /** Where to return after saving (same dealership page, with filters). */
  back: string;
  summary?: string;
}) {
  const [opened, setOpened] = useState(false);
  const uid = `${fingerprint ?? checkKey ?? "x"}`.slice(0, 16);
  return (
    <details className="mt-1" onToggle={(e) => e.currentTarget.open && setOpened(true)}>
      <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:underline">{summary}</summary>
      {opened && (
        <form action={updateIssueStateAction} className="mt-2 w-56 max-w-full space-y-2 rounded-md border border-slate-200 bg-white p-2.5">
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
      )}
    </details>
  );
}
