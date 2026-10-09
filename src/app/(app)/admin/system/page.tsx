import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { emailConfigProblem } from "@/lib/email/config";
import { getCrawlers, getEmailRecipientHealth, getJobOverview, getRecentEmails, getRecentScanFailures, getSystemLogs } from "@/lib/queries/system";
import { allRegions } from "@/lib/crawler/regions";
import { ONLINE_WINDOW_MINUTES } from "@/lib/crawler/heartbeat";
import { ALL_PROVIDERS, activeProviders } from "@/lib/news/providers";
import { pageSpeedEnabled } from "@/lib/seo/pagespeed";
import { remoteAuditAvailable } from "@/lib/seo/remote-audit";
import { aiReportsConfigured } from "@/lib/reports/ai";
import { aiReportsUsedThisMonth } from "@/lib/reports/service";
import { retryJobAction, runTickNowAction } from "@/app/actions/settings";
import { SubmitButton } from "@/components/client/submit-button";
import { Badge, Card, Notice, PageHeader, TableWrap } from "@/components/ui";
import { fmtDateTime, fmtRelative } from "@/components/format";

export const metadata: Metadata = { title: "System" };
export const dynamic = "force-dynamic";

const JOB_LABEL: Record<string, string> = { seo_scan: "SEO scan", news_scan: "News check", digest: "Email summary", alert: "Critical alert email", maintenance: "Maintenance", report: "SEO report" };

export default async function SystemPage({ searchParams }: { searchParams: Promise<{ notice?: string }> }) {
  await requireAdmin();
  const { notice } = await searchParams;
  const tz = env().APP_TIMEZONE;
  const [jobs, failures, logs, emails, crawlers, aiUsed, recipients] = await Promise.all([
    getJobOverview(),
    getRecentScanFailures(),
    getSystemLogs(),
    getRecentEmails(),
    getCrawlers(),
    aiReportsUsedThisMonth(),
    getEmailRecipientHealth(),
  ]);
  const regions = allRegions(env().CRAWLER_EXTRA_REGIONS);
  const onlineCutoff = jobs.generatedAt - ONLINE_WINDOW_MINUTES * 60_000;
  const defaultRegion = env().DEFAULT_CRAWLER_REGION;
  const active = new Set(activeProviders().map((p) => p.id));

  return (
    <>
      {notice === "tick-started" && <Notice tone="success">Processing started in the background. Refresh in a minute to see progress.</Notice>}
      {recipients.noRecipientsAtAll ? (
        <Notice tone="warning">
          <strong>No active email recipients configured.</strong> Nothing is being delivered — no critical alerts, no digests, no newsletter.{" "}
          <Link href="/admin/settings" className="underline">
            Add management recipients
          </Link>{" "}
          or add notification emails to each dealership.
          {recipients.skippedForNoRecipients > 0 && ` ${recipients.skippedForNoRecipients} email${recipients.skippedForNoRecipients === 1 ? " has" : "s have"} already been skipped for this reason.`}
        </Notice>
      ) : (
        recipients.uncovered.length > 0 && (
          <Notice tone="warning">
            <strong>
              {recipients.uncovered.length} dealership{recipients.uncovered.length === 1 ? "" : "s"} with no email recipients:
            </strong>{" "}
            {recipients.uncovered.map((d) => d.name).join(", ")}. Alerts for{" "}
            {recipients.uncovered.length === 1 ? "it" : "them"} cannot be delivered.{" "}
            <Link href="/admin/dealerships" className="underline">
              Add notification emails
            </Link>
            .
          </Notice>
        )
      )}
      <PageHeader
        title="System"
        description="Background processing, failures and delivery logs."
        actions={
          <form action={runTickNowAction}>
            <SubmitButton className="btn" pendingText="Starting…">
              Process queue now
            </SubmitButton>
          </form>
        }
      />
      {jobs.schedulerStale && (jobs.counts.queued ?? 0) > 0 && (
        <Notice tone="warning">
          Jobs are queued but none have started in the last 3 hours. Check that the cron schedule is configured (Vercel Cron or the external scheduler) and that CRON_SECRET matches. See the README “Scheduling” section.
        </Notice>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Queue">
          <dl className="grid grid-cols-2 gap-2 text-sm">
            {["queued", "running", "completed", "failed"].map((s) => (
              <div key={s}>
                <dt className="capitalize text-slate-500">{s}</dt>
                <dd className="text-lg font-semibold tabular-nums">{jobs.counts[s] ?? 0}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-xs text-slate-500">Last job started {fmtRelative(jobs.lastJobStartedAt)}</p>
        </Card>
        <Card title="News sources">
          <ul className="space-y-1 text-sm">
            {ALL_PROVIDERS.map((p) => (
              <li key={p.id} className="flex justify-between">
                {p.label}
                {active.has(p.id) ? <Badge tone="success">Active</Badge> : <Badge>{p.isConfigured() ? "Disabled" : "No API key"}</Badge>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Integrations">
          <ul className="space-y-1 text-sm">
            <li className="flex justify-between">
              Email <Badge tone={emailConfigProblem(env()) ? "warning" : "success"}>{emailConfigProblem(env()) ? `${env().EMAIL_PROVIDER} · not delivering` : env().EMAIL_PROVIDER}</Badge>
            </li>
            <li className="flex justify-between">
              PageSpeed Insights <Badge tone={pageSpeedEnabled() ? "success" : "neutral"}>{pageSpeedEnabled() ? "Active" : "Not configured"}</Badge>
            </li>
            <li className="flex justify-between">
              Google remote check <Badge tone={remoteAuditAvailable() ? "success" : "neutral"}>{remoteAuditAvailable() ? "Active" : "Needs PAGESPEED_API_KEY"}</Badge>
            </li>
            <li className="flex justify-between">
              AI reports{" "}
              {aiReportsConfigured() ? (
                <span className="font-medium tabular-nums">
                  {aiUsed} / {env().AI_REPORTS_MONTHLY_LIMIT} this month
                </span>
              ) : (
                <Badge>Not configured</Badge>
              )}
            </li>
            <li className="flex justify-between">
              Crawl-job API <Badge tone={env().CRAWLER_API_TOKEN ? "success" : "neutral"}>{env().CRAWLER_API_TOKEN ? "Enabled" : "Disabled"}</Badge>
            </li>
            <li className="flex justify-between">
              Job concurrency <span className="font-medium">{env().JOB_CONCURRENCY}</span>
            </li>
          </ul>
        </Card>
        <Card title="Timezone">
          <p className="text-sm">{tz}</p>
          <p className="mt-1 text-xs text-slate-500">Used for email schedules and displayed times.</p>
        </Card>
      </div>

      <div className="space-y-5">
        <section>
          <h2 className="mb-2 text-base font-semibold">Crawler regions</h2>
          <p className="mb-2 text-sm text-slate-600">
            Mode: <strong>{env().CRAWLER_MODE === "worker" ? "Dedicated crawler workers" : "Vercel Cron (US-East)"}</strong> · Default region: <strong>{regions.find((r) => r.id === defaultRegion)?.label ?? defaultRegion}</strong>. Scans waiting {">"}30 minutes for an offline region are moved to the default region.
          </p>
          <TableWrap caption="Crawler regions">
            <thead>
              <tr>
                <th scope="col">Region</th>
                <th scope="col">Crawlers online</th>
                <th scope="col">Scans waiting</th>
                <th scope="col">Suggested hosting</th>
              </tr>
            </thead>
            <tbody>
              {regions.map((r) => {
                const online = crawlers.workers.filter((w) => w.region === r.id && w.lastSeenAt.getTime() > onlineCutoff);
                const waiting = crawlers.waiting.filter((w) => (w.region ?? defaultRegion) === r.id).reduce((a, w) => a + w.n, 0);
                return (
                  <tr key={r.id}>
                    <td className="font-medium">
                      {r.label}
                      {r.id === defaultRegion && <span className="ml-1 text-xs text-slate-500">(default)</span>}
                    </td>
                    <td>{online.length ? <Badge tone="success">{online.length} online</Badge> : <Badge>{r.id === defaultRegion && env().CRAWLER_MODE === "vercel" ? "Vercel Cron" : "None"}</Badge>}</td>
                    <td className="tabular-nums">{waiting}</td>
                    <td className="text-xs text-slate-500">{r.hosting}</td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
          {crawlers.workers.length > 0 && (
            <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
              {crawlers.workers.map((w) => (
                <li key={w.id}>
                  {w.lastSeenAt.getTime() > onlineCutoff ? "🟢" : "⚪"} <span className="font-mono">{w.id}</span> · {w.kind} · {w.region} · last seen {fmtRelative(w.lastSeenAt)} · {w.jobsProcessed} jobs
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold">Active & queued jobs</h2>
          <TableWrap caption="Active and queued jobs">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Dealership</th>
                <th scope="col">Status</th>
                <th scope="col">Attempts</th>
                <th scope="col">Run after</th>
              </tr>
            </thead>
            <tbody>
              {jobs.active.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-5 text-center text-slate-500">
                    Nothing queued.
                  </td>
                </tr>
              )}
              {jobs.active.map(({ job, dealershipName }) => (
                <tr key={job.id}>
                  <td>{JOB_LABEL[job.type] ?? job.type}</td>
                  <td>{dealershipName ?? "—"}</td>
                  <td>{job.status === "running" ? <Badge tone="accent">Running</Badge> : <Badge>Queued</Badge>}</td>
                  <td className="tabular-nums">{job.attempts}</td>
                  <td className="whitespace-nowrap">{fmtDateTime(job.runAfter, tz)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold">Failed jobs</h2>
          <TableWrap caption="Failed jobs">
            <thead>
              <tr>
                <th scope="col">Job</th>
                <th scope="col">Dealership</th>
                <th scope="col">Error</th>
                <th scope="col">When</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {jobs.failed.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-5 text-center text-slate-500">
                    No failed jobs.
                  </td>
                </tr>
              )}
              {jobs.failed.map(({ job, dealershipName }) => (
                <tr key={job.id}>
                  <td>{JOB_LABEL[job.type] ?? job.type}</td>
                  <td>{dealershipName ?? "—"}</td>
                  <td className="max-w-md text-red-700">{job.lastError}</td>
                  <td className="whitespace-nowrap">{fmtDateTime(job.completedAt, tz)}</td>
                  <td>
                    <form action={retryJobAction}>
                      <input type="hidden" name="jobId" value={job.id} />
                      <SubmitButton className="btn btn-sm" pendingText="…">
                        Retry
                      </SubmitButton>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold">Scan failures</h2>
          <TableWrap caption="Recent scan failures">
            <thead>
              <tr>
                <th scope="col">Dealership</th>
                <th scope="col">Reason</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {failures.length === 0 && (
                <tr>
                  <td colSpan={3} className="py-5 text-center text-slate-500">
                    No scan failures.
                  </td>
                </tr>
              )}
              {failures.map(({ scan, dealershipName }) => (
                <tr key={scan.id}>
                  <td>
                    <Link href={`/dealerships/${scan.dealershipId}?tab=history`} className="text-brand-700 hover:underline">
                      {dealershipName}
                    </Link>
                  </td>
                  <td className="max-w-lg">{scan.errorMessage}</td>
                  <td className="whitespace-nowrap">{fmtDateTime(scan.createdAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold">Email log</h2>
          <TableWrap caption="Recent emails">
            <thead>
              <tr>
                <th scope="col">Type</th>
                <th scope="col">To</th>
                <th scope="col">Subject</th>
                <th scope="col">Status</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {emails.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-5 text-center text-slate-500">
                    No emails yet. Emails are only sent when something meaningful changes.
                  </td>
                </tr>
              )}
              {emails.map((m) => (
                <tr key={m.id}>
                  <td className="whitespace-nowrap">{m.kind.replace("_", " ")}</td>
                  <td>{m.recipients.join(", ")}</td>
                  <td className="max-w-md">{m.subject}</td>
                  <td>
                    {m.status === "sent" && m.providerMessageId?.startsWith("console-") ? (
                      <span title="EMAIL_PROVIDER=console: written to the server log, not delivered">
                        <Badge tone="warning">Logged only</Badge>
                      </span>
                    ) : m.status === "sent" ? (
                      <Badge tone="success">Sent</Badge>
                    ) : m.status === "failed" ? (
                      <span title={m.error ?? undefined}>
                        <Badge tone="critical">Failed</Badge>
                      </span>
                    ) : (
                      <Badge>{m.status}</Badge>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{fmtDateTime(m.sentAt ?? m.createdAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>

        <section>
          <h2 className="mb-2 text-base font-semibold">System log (warnings & errors)</h2>
          <TableWrap caption="System log">
            <thead>
              <tr>
                <th scope="col">Level</th>
                <th scope="col">Source</th>
                <th scope="col">Message</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-5 text-center text-slate-500">
                    No warnings or errors logged.
                  </td>
                </tr>
              )}
              {logs.map((l) => (
                <tr key={l.id}>
                  <td>{l.level === "error" ? <Badge tone="critical">Error</Badge> : <Badge tone="warning">Warning</Badge>}</td>
                  <td>{l.source}</td>
                  <td className="max-w-xl">
                    {l.message}
                    {l.details && typeof l.details.error === "string" && <div className="text-xs text-slate-500">{l.details.error}</div>}
                  </td>
                  <td className="whitespace-nowrap">{fmtDateTime(l.createdAt, tz)}</td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>
      </div>
    </>
  );
}
