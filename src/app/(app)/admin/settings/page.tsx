import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { getSettings } from "@/lib/settings";
import { sendNewsletterPreviewAction, sendTestEmailAction } from "@/app/actions/settings";
import { SettingsForm } from "@/components/admin/settings-form";
import { SubmitButton } from "@/components/client/submit-button";
import { Card, Notice, PageHeader } from "@/components/ui";
import { emailConfigNote, emailConfigProblem } from "@/lib/email/config";
import { getLastTestEmailError } from "@/lib/queries/system";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  const user = await requireAdmin();
  const { notice } = await searchParams;
  const settings = await getSettings();
  const e = env();
  const problem = emailConfigProblem(e);
  const note = emailConfigNote(e);
  const lastError = notice === "test-failed" ? await getLastTestEmailError() : null;
  return (
    <>
      {notice === "test-sent" && <Notice tone="success">Test email sent. Check your inbox (and spam folder).</Notice>}
      {notice === "preview-sent" && <Notice tone="success">Newsletter preview sent. Check your inbox (and spam folder).</Notice>}
      {notice === "test-console" && (
        <Notice tone="warning">
          Not delivered: email is in development mode (EMAIL_PROVIDER=console), so the test email was only written to the server log. Configure Resend or SMTP to deliver real emails.
        </Notice>
      )}
      {notice === "test-failed" && (
        <Notice tone="critical">
          The test email could not be sent.{lastError ? ` ${lastError}` : " See Admin → System for the error details."}
        </Notice>
      )}
      {notice === "rate-limited" && <Notice tone="warning">Too many test emails in the last hour.</Notice>}
      <PageHeader title="Settings" description="Scheduling, email reports and change-detection thresholds." />
      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <SettingsForm settings={settings} timezone={e.APP_TIMEZONE} />
        </Card>
        <div className="space-y-5">
          <Card title="Email delivery">
            <p className="text-sm text-slate-600">
              Provider: <strong>{e.EMAIL_PROVIDER}</strong>
            </p>
            <p className="mt-1 break-words text-sm text-slate-600">From: {e.EMAIL_FROM}</p>
            {problem ? (
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-inset ring-amber-200">
                <strong>Not delivering:</strong> {problem}
              </p>
            ) : (
              <p className="mt-2 text-sm text-emerald-700">Configured for delivery. Send a test email to confirm.</p>
            )}
            {note && <p className="mt-2 text-xs text-slate-500">{note}</p>}
            <form action={sendTestEmailAction} className="mt-3 space-y-2">
              <label htmlFor="to" className="label">
                Send a test email to
              </label>
              <input id="to" name="to" type="email" defaultValue={user.email} className="input" />
              <SubmitButton className="btn" pendingText="Sending…">
                Send test email
              </SubmitButton>
            </form>
            <form action={sendNewsletterPreviewAction} className="mt-4 space-y-2 border-t border-slate-100 pt-4">
              <input type="hidden" name="to" value={user.email} />
              <p className="text-sm text-slate-600">See this week’s newsletter now, exactly as recipients will get it.</p>
              <SubmitButton className="btn" pendingText="Sending…">
                Send newsletter preview to me
              </SubmitButton>
            </form>
          </Card>
          <Card title="Scoring rules">
            <p className="text-sm text-slate-600">
              SEO scores are calculated by fixed, deterministic rules (no AI). Check weights, severities and thresholds are defined in <code className="rounded bg-slate-100 px-1 text-xs">src/lib/seo/checks/config.ts</code> so they can be reviewed and adjusted by a developer.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
