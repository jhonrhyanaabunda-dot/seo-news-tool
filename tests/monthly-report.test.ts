import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isMonthlySendDay, monthSummaryLine, reportedMonth, reportedMonthFromKey } from "@/lib/reports/monthly";
import { renderReportEmail } from "@/lib/email/templates";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (src: string, signature: string) => {
  const from = src.slice(src.indexOf(signature));
  return from.slice(0, from.indexOf("\n}\n") + 2);
};

test("the report sent on the 1st covers the month that just ended", () => {
  assert.equal(isMonthlySendDay("2026-11-01"), true);
  assert.equal(isMonthlySendDay("2026-11-02"), false);
  assert.deepEqual({ ...reportedMonth("2026-11-01"), start: undefined }, { key: "2026-10", label: "October 2026", start: undefined });
  assert.equal(reportedMonth("2027-01-01").key, "2026-12", "January covers December of the previous year");
  assert.equal(reportedMonth("2027-01-01").label, "December 2026");
  assert.equal(reportedMonthFromKey("2026-10").start.toISOString(), "2026-10-01T00:00:00.000Z");
});

test("the month line states the change truthfully", () => {
  assert.equal(monthSummaryLine("October 2026", 88, 84), "October 2026: SEO score 88/100, up 4 points from 84 at the start of the month.");
  assert.equal(monthSummaryLine("October 2026", 83, 84), "October 2026: SEO score 83/100, down 1 point from 84 at the start of the month.");
  assert.equal(monthSummaryLine("October 2026", 84, 84), "October 2026: SEO score 84/100, unchanged over the month.");
  assert.match(monthSummaryLine("October 2026", 84, null), /first month on record/);
  assert.match(monthSummaryLine("October 2026", null, 80), /could not be scored/);
});

test("the monthly email names the month; the on-demand email is unchanged", () => {
  const base = {
    dealershipName: "BMW of Fort Walton Beach", websiteUrl: "https://www.bmwfwb.com/", score: 85, statusLabel: "Completed", pagesAnalyzed: 60, pagesProtected: 0,
    executiveSummary: "Summary.", actions: [], protectedPagesNote: null, newsSummary: null, reportUrl: "https://x/r", dashboardUrl: "https://x",
  };
  const monthly = renderReportEmail({ ...base, period: "October 2026", periodLine: "October 2026: SEO score 85/100, up 1 point from 84 at the start of the month." });
  assert.equal(monthly.subject, "Monthly SEO report: BMW of Fort Walton Beach, October 2026");
  assert.ok(monthly.html.includes("monthly SEO report, October 2026") && monthly.html.includes("up 1 point from 84"));
  assert.ok(monthly.text.includes("up 1 point from 84"));
  assert.equal(renderReportEmail(base).subject, "SEO report: BMW of Fort Walton Beach");
});

test("monthly reports are off until switched on, and run once per month on the 1st", () => {
  // Settings import the database client, so the default is checked in the schema source.
  assert.ok(read("src/lib/settings.ts").includes("monthlyReportsEnabled: z.boolean().default(false),"), "it emails clients, so it starts off");
  const scheduler = read("src/lib/jobs/scheduler.ts");
  const block = scheduler.slice(scheduler.indexOf("// Monthly SEO report"), scheduler.indexOf('if (await claimPeriod("maintenance"'));
  assert.ok(block.includes("s.monthlyReportsEnabled && isMonthlySendDay(local.date) && local.hour >= s.dailyDigestHour"));
  assert.ok(block.includes('claimPeriod("monthly-report", month.key)'), "claimed once per month");
  assert.ok(block.includes("eq(dealerships.isActive, true), eq(dealerships.seoEnabled, true)"));
  assert.ok(scheduler.indexOf("if (s.schedulerPaused) return out;") < scheduler.indexOf("// Monthly SEO report"), "pausing the scheduler pauses it");
});

test("a monthly report is emailed only when completed, once per month and recipient", () => {
  const runner = read("src/lib/jobs/runner.ts");
  assert.ok(runner.includes('job.payload.monthly && r.status === "completed" ? await emailMonthlyReport('));
  const svc = read("src/lib/reports/service.ts");
  const send = fnBody(svc, "export async function emailMonthlyReport");
  assert.ok(send.includes("dedupeKey: `monthly-report:${monthKey}:${dealer.id}:${to}`"));
  assert.ok(send.includes("recordSkippedNoRecipients("), "no recipients is recorded, not silent");
  assert.ok(send.includes("if (failed > 0) throw"), "failures retry; sent ones are skipped by their keys");
  const request = fnBody(svc, "export async function requestMonthlyReport");
  assert.ok(request.includes("dedupeKey: `monthly-report:${monthKey}:${dealershipId}`"), "one job per dealership per month");
  const preview = fnBody(svc, "export async function sendMonthlyReportPreview");
  assert.ok(preview.includes('kind: "test"') && preview.includes("[Preview]"), "the preview goes to the admin only, as a test email");
});

test("report emails explain why they arrived, and show the status in plain case", () => {
  const base = {
    dealershipName: "BMW of Fort Walton Beach", websiteUrl: "https://www.bmwfwb.com/", score: 85, statusLabel: "COMPLETED", pagesAnalyzed: 60, pagesProtected: 0,
    executiveSummary: "Summary.", actions: [], protectedPagesNote: null, newsSummary: null, reportUrl: "https://x/r", dashboardUrl: "https://x",
  };
  const monthly = renderReportEmail({ ...base, period: "October 2026", periodLine: "line" });
  assert.ok(monthly.html.includes("You receive this monthly report because"));
  assert.ok(!monthly.html.includes("only sent when something meaningful changes"), "a monthly report is not change-triggered");
  assert.ok(monthly.html.includes("<strong>Status:</strong> Completed") && monthly.text.includes("Status: Completed"));
  assert.ok(renderReportEmail(base).html.includes("an A3 Brands administrator sent it"));
});
