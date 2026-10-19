/**
 * The admin "Getting started" checklist, derived from real state only — never
 * from a "done" flag someone ticked. Pure module so the rules are unit-tested;
 * `queries/onboarding.ts` gathers the state.
 */

export interface GettingStartedState {
  dealerships: number;
  completedScans: number;
  /** Management recipients in Settings, plus dealerships with their own notification emails. */
  managementRecipients: number;
  dealershipsWithRecipients: number;
  /** null when email is configured for delivery; otherwise the reason it is not. */
  emailProblem: string | null;
  pageSpeedKey: boolean;
  aiKey: boolean;
}

export interface ChecklistItem {
  key: "dealerships" | "scan" | "recipients" | "email" | "pagespeed" | "ai";
  label: string;
  done: boolean;
  /** What is true now, or what to do. */
  detail: string;
  href: string;
  /** Optional integrations are shown but do not hold the checklist open. */
  optional: boolean;
}

export function gettingStartedItems(s: GettingStartedState): ChecklistItem[] {
  return [
    {
      key: "dealerships",
      label: "Add your dealerships",
      done: s.dealerships > 0,
      detail: s.dealerships > 0 ? `${s.dealerships} dealership${s.dealerships === 1 ? "" : "s"} monitored.` : "Add the first dealership website; it is scanned automatically.",
      href: s.dealerships > 0 ? "/admin/dealerships" : "/admin/dealerships/new",
      optional: false,
    },
    {
      key: "scan",
      label: "Complete a first scan",
      done: s.completedScans > 0,
      detail: s.completedScans > 0 ? "At least one SEO scan has completed." : "Scans start on their own; if none finishes, check that the crawler or the cron schedule is running.",
      href: "/admin/system",
      optional: false,
    },
    {
      key: "recipients",
      label: "Choose who receives reports",
      done: s.managementRecipients + s.dealershipsWithRecipients > 0,
      detail:
        s.managementRecipients + s.dealershipsWithRecipients > 0
          ? `${s.managementRecipients} management recipient${s.managementRecipients === 1 ? "" : "s"}; ${s.dealershipsWithRecipients} dealership${s.dealershipsWithRecipients === 1 ? "" : "s"} with their own contacts.`
          : "Add management recipients in Settings, or notification emails on each dealership. Until then digests and alerts reach nobody.",
      href: "/admin/settings",
      optional: false,
    },
    {
      key: "email",
      label: "Configure email delivery",
      done: s.emailProblem === null,
      detail: s.emailProblem ?? "Email is configured for delivery. Send a test from Settings to confirm.",
      href: "/admin/settings",
      optional: false,
    },
    {
      key: "pagespeed",
      label: "Add a PageSpeed Insights key",
      done: s.pageSpeedKey,
      detail: s.pageSpeedKey ? "Performance metrics and the limited check for blocked sites are on." : "Optional: set PAGESPEED_API_KEY for performance metrics and a fallback check when a site blocks the crawler.",
      href: "/admin/system",
      optional: true,
    },
    {
      key: "ai",
      label: "Add an AI key for report summaries",
      done: s.aiKey,
      detail: s.aiKey ? "Report summaries are written by Claude from the stored findings." : "Optional: set ANTHROPIC_API_KEY. Without it, reports are composed directly from the findings.",
      href: "/admin/system",
      optional: true,
    },
  ];
}

/** The checklist stays on the dashboard until every required item is done. */
export function checklistComplete(items: ChecklistItem[]): boolean {
  return items.every((i) => i.done || i.optional);
}
