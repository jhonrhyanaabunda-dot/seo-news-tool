import type { IssueState } from "@/lib/db/schema";
import { cameBack, describeState } from "@/lib/issues/workflow";
import { Badge } from "@/components/ui";

/**
 * Issue workflow UI: a status badge everyone sees. The admin form that changes
 * it is in client/issue-workflow-editor.tsx.
 */
export { IssueWorkflowEditor } from "@/components/client/issue-workflow-editor";

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
