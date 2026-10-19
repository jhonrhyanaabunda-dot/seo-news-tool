import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/lib/auth/guards";
import { accessibleDealershipIds, isClient } from "@/lib/auth/tenant";
import { WelcomeGuide } from "@/components/welcome-guide";
import { WorkflowScoreNote } from "@/components/issue-workflow";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Help" };

/** The welcome guide, re-openable at any time, plus the few rules worth knowing. */
export default async function HelpPage() {
  const user = await requireUser();
  const dealershipId = isClient(user) ? (((await accessibleDealershipIds(user)) ?? [])[0] ?? null) : null;
  return (
    <>
      <PageHeader title="Help" description="How the SEO monitor works, in plain language." />
      <WelcomeGuide dealershipId={dealershipId} dismissible={false} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="How the score works">
          <p className="text-sm text-slate-600">
            The score is a weighted average of seven areas (technical, page titles and descriptions, content, links, images, structured data and crawlability). Each rule deducts
            points according to how much of the website it affects. No AI is involved in scoring, and pages the website blocked us from checking are never counted against you.
          </p>
          <WorkflowScoreNote className="mt-3 text-sm text-slate-600" />
        </Card>
        <Card title="Emails" className="scroll-mt-6">
          <div id="emails" className="space-y-2 text-sm text-slate-600">
            <p>
              <strong>Summaries</strong> are sent when something meaningful changed: new or resolved problems, a large score change, relevant news, or the website becoming
              unavailable.
            </p>
            <p>
              <strong>Alerts</strong> are sent straight away if the website cannot be reached or a new critical problem appears.
            </p>
            <p>
              <strong>Monthly reports</strong> (when A3 has turned them on) summarise the month: your score, what to do next and what changed since last month, with the PDF report
              attached. If the PDF could not be produced at the time, the email links to the report, where you can download it after signing in.
            </p>
            <p>
              Emails never contain passwords or anything that signs you in: their links open the monitor, which asks you to sign in first. To add or change who receives them,
              contact your A3 Brands account manager.
            </p>
          </div>
        </Card>
      </div>
      <p className="mt-5 text-sm text-slate-500">
        <Link href="/account" className="text-brand-700 hover:underline">
          Your account
        </Link>
      </p>
    </>
  );
}
