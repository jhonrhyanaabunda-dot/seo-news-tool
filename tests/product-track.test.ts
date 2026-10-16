import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MAX_PERIOD_RELEASES, nextPeriodRelease, periodClaimOf } from "@/lib/jobs/period-retry";
import { manualMonthlyReportJob, monthLabel, monthlyEmailDedupeKey, monthlyReportJob, monthlyReportMonthDue, monthsEndingWith, previousMonth } from "@/lib/reports/monthly-schedule";
import { alignToMonths, compareMonths, isSnapshotEligible, monthOf, replacesSnapshot, summarizeChecks } from "@/lib/history/monthly";
import { applyStatusChange, cameBack, describeState, isActionable, parseWorkflowFilter, reconcileFixedStates, type ReconcileInput } from "@/lib/issues/workflow";
import { urlKey } from "@/lib/seo/checks/evaluate";
import { A3_BRAND_COLOR, checkLogoUrlShape, contrastRatio, normalizeBrandColor, resolveBranding, textColorOn } from "@/lib/dealerships/branding";
import { checklistComplete, gettingStartedItems, type GettingStartedState } from "@/lib/onboarding/checklist";
import { renderMonthlyReportEmail, renderReportEmail, type MonthlyReportEmailInput } from "@/lib/email/templates";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (src: string, signature: string) => {
  const from = src.slice(src.indexOf(signature));
  return from.slice(0, from.indexOf("\n}\n") + 2);
};

/* ── 1. Period claims: bounded re-runs after a permanent failure ─────── */

test("a failed period may be released a bounded number of times, then never again that period", () => {
  let marker: unknown = null;
  const granted: boolean[] = [];
  for (let i = 0; i < MAX_PERIOD_RELEASES + 3; i++) {
    const r = nextPeriodRelease(marker, "2026-10-16");
    granted.push(r.allowed);
    marker = r.marker;
  }
  assert.equal(granted.filter(Boolean).length, MAX_PERIOD_RELEASES);
  assert.deepEqual(granted.slice(0, MAX_PERIOD_RELEASES), Array(MAX_PERIOD_RELEASES).fill(true));
  assert.ok(granted.slice(MAX_PERIOD_RELEASES).every((g) => !g), "a mail server that stays down cannot become a retry loop");
});

test("the release budget resets every period and survives a corrupt marker", () => {
  const spent = { period: "2026-10-15", releases: MAX_PERIOD_RELEASES };
  assert.equal(nextPeriodRelease(spent, "2026-10-15").allowed, false);
  assert.deepEqual(nextPeriodRelease(spent, "2026-10-16"), { allowed: true, marker: { period: "2026-10-16", releases: 1 } });
  for (const junk of [null, undefined, "x", 3, { period: 1 }, { period: "2026-10-16", releases: "lots" }]) {
    assert.equal(nextPeriodRelease(junk, "2026-10-16").allowed, true, `marker ${JSON.stringify(junk)} must not silence a digest`);
  }
  assert.equal(nextPeriodRelease(null, "p", 0).allowed, false, "max 0 disables re-runs");
});

test("a failed job maps to exactly the claim the scheduler took", () => {
  assert.deepEqual(periodClaimOf("digest", { kind: "daily", periodKey: "2026-10-16" }), { key: "digest:daily", period: "2026-10-16" });
  assert.deepEqual(periodClaimOf("digest", { kind: "weekly", periodKey: "2026-10-12" }), { key: "digest:weekly", period: "2026-10-12" });
  assert.deepEqual(periodClaimOf("monthly_report", monthlyReportJob(7, "2026-10").payload), { key: "monthly-report:7", period: "2026-10" });
  // A manual test send holds no claim: its failure must never hand back the scheduled month.
  assert.equal(periodClaimOf("monthly_report", manualMonthlyReportJob(7, "2026-10", 1, "a@example.invalid", "n").payload), null);
  for (const t of ["seo_scan", "alert", "report", "maintenance", "report_pdf"]) assert.equal(periodClaimOf(t, { periodKey: "2026-10-16" }), null);
  assert.equal(periodClaimOf("digest", {}), null);

  const scheduler = read("src/lib/jobs/scheduler.ts");
  assert.ok(scheduler.includes("claimAndEnqueue(`monthly-report:${id}`, month, monthlyReportJob(id, month))"), "monthly claim key matches periodClaimOf");
});

test("re-running a released digest or monthly report cannot email anyone twice", () => {
  // Per-recipient keys are derived only from the period and the address, so a
  // fresh job for the same period produces the same keys and sendTrackedEmail
  // skips everyone already served (status sent/skipped).
  const reports = read("src/lib/email/reports.ts");
  assert.ok(reports.includes("dedupeKey: `digest:${kind}:${periodKey}:${email}`"), "digest key = period + recipient");
  const send = fnBody(read("src/lib/email/send.ts"), "export async function sendTrackedEmail");
  assert.ok(/existing\.status === "sent" \|\| existing\.status === "skipped"\) return "skipped"/.test(send), "an already-sent key is never sent again");
  assert.ok(send.indexOf(".onConflictDoNothing()") < send.indexOf("getEmailProvider().send"), "the row is written before sending");

  const scheduled = monthlyReportJob(3, "2026-10").payload;
  assert.equal(monthlyEmailDedupeKey(scheduled, "gm@example.invalid"), monthlyEmailDedupeKey({ ...scheduled }, "gm@example.invalid"), "stable across re-runs");
  const manual = manualMonthlyReportJob(3, "2026-10", 1, null, "abc").payload;
  assert.notEqual(monthlyEmailDedupeKey(manual, "gm@example.invalid"), monthlyEmailDedupeKey(scheduled, "gm@example.invalid"), "a test send never uses up the scheduled send");
  const monthly = read("src/lib/reports/monthly.ts");
  assert.ok(monthly.includes("dedupeKey: monthlyEmailDedupeKey(payload, to)"));
});

/* ── 2. Monthly report schedule ─────────────────────────────────────── */

test("the monthly report is due from its day and hour for the rest of the month, and off by default", () => {
  const s = { monthlyReportEnabled: true, monthlyReportDay: 3, monthlyReportHour: 8 };
  assert.equal(monthlyReportMonthDue({ date: "2026-10-02", hour: 23 }, s), null);
  assert.equal(monthlyReportMonthDue({ date: "2026-10-03", hour: 7 }, s), null);
  assert.equal(monthlyReportMonthDue({ date: "2026-10-03", hour: 8 }, s), "2026-10");
  assert.equal(monthlyReportMonthDue({ date: "2026-10-19", hour: 0 }, s), "2026-10", "a missed tick still sends later that month");
  assert.equal(monthlyReportMonthDue({ date: "2026-10-19", hour: 9 }, { ...s, monthlyReportEnabled: false }), null);
  const settings = read("src/lib/settings.ts");
  assert.ok(settings.includes("monthlyReportEnabled: z.boolean().default(false)"), "disabled until an admin turns it on");
  assert.ok(settings.includes("monthlyReportDay: z.coerce.number().int().min(1).max(28).default(1)"), "day 29–31 would skip short months");
  assert.ok(read("src/app/actions/settings.ts").includes("monthlyReportDay: z.coerce.number().int().min(1).max(28)"), "the form is validated server-side too");
});

test("month helpers", () => {
  assert.equal(monthLabel("2026-10"), "October 2026");
  assert.equal(previousMonth("2026-01"), "2025-12");
  assert.equal(previousMonth("2026-10"), "2026-09");
  assert.deepEqual(monthsEndingWith("2026-02", 4), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.equal(monthsEndingWith("2026-10", 12).length, 12);
});

/* ── 3. Long-term monthly history ──────────────────────────────────── */

test("a scan belongs to its month in the app's timezone, not UTC", () => {
  // 04:30 UTC on 1 November is 23:30 on 31 October in Chicago (CDT).
  assert.equal(monthOf(new Date("2026-11-01T04:30:00Z"), "America/Chicago"), "2026-10");
  assert.equal(monthOf(new Date("2026-11-01T06:30:00Z"), "America/Chicago"), "2026-11");
  assert.equal(monthOf(new Date("2026-11-01T04:30:00Z"), "UTC"), "2026-11");
});

test("only a full, scored, reachable scan stands for a month", () => {
  const ok = { status: "completed", outcome: "completed", score: 88, siteAvailable: true, completedAt: new Date(), auditMode: "full" };
  assert.equal(isSnapshotEligible(ok), true);
  assert.equal(isSnapshotEligible({ ...ok, outcome: "completed_with_warnings" }), true);
  for (const bad of [{ outcome: "blocked" }, { outcome: "partially_blocked" }, { score: null }, { siteAvailable: false }, { status: "failed" }, { auditMode: "remote" }, { completedAt: null }]) {
    assert.equal(isSnapshotEligible({ ...ok, ...bad } as typeof ok), false, JSON.stringify(bad));
  }
  const t = new Date("2026-10-10T00:00:00Z");
  assert.equal(replacesSnapshot(null, t), true);
  assert.equal(replacesSnapshot(new Date("2026-10-09T00:00:00Z"), t), true, "the later scan of the month wins");
  assert.equal(replacesSnapshot(new Date("2026-10-11T00:00:00Z"), t), false, "an older backfill never overwrites a later scan");
  assert.equal(replacesSnapshot(t, t), true, "re-running is idempotent");
  const upsert = read("src/lib/history/snapshots.ts");
  assert.ok(/setWhere: sql`\$\{seoMonthlySnapshots\.scanCompletedAt\} <= /.test(upsert), "the upsert applies the same latest-wins rule");
});

test("a snapshot's per-check summary counts distinct URLs and keeps at most five samples, in the shared order", () => {
  const rows = [
    ...Array.from({ length: 7 }, (_, i) => ({ checkKey: "image_alt_missing", severity: "warning" as const, url: `https://x.example/p${i}` })),
    { checkKey: "image_alt_missing", severity: "warning" as const, url: "https://x.example/p0" },
    { checkKey: "title_missing", severity: "critical" as const, url: "https://x.example/a" },
  ];
  const s = summarizeChecks(rows);
  assert.equal(s[0].checkKey, "title_missing", "critical first");
  assert.equal(s[1].affectedPages, 7, "duplicates collapse");
  assert.equal(s[1].sampleUrls.length, 5);
  assert.deepEqual(s[1].sampleUrls, [...s[1].sampleUrls].sort());
  assert.deepEqual(summarizeChecks([...rows].reverse()), s, "order-independent");
});

test("month-over-month comparison", () => {
  const prev = { month: "2026-09", score: 70, checks: [
    { checkKey: "title_missing", priority: "CRITICAL" as const, affectedPages: 2 },
    { checkKey: "image_alt_missing", priority: "HIGH" as const, affectedPages: 10 },
    { checkKey: "h1_missing", priority: "HIGH" as const, affectedPages: 3 },
    { checkKey: "canonical_missing", priority: "MEDIUM" as const, affectedPages: 4 },
  ] };
  const curr = { month: "2026-10", score: 78, checks: [
    { checkKey: "image_alt_missing", priority: "HIGH" as const, affectedPages: 4 },
    { checkKey: "h1_missing", priority: "HIGH" as const, affectedPages: 5 },
    { checkKey: "canonical_missing", priority: "MEDIUM" as const, affectedPages: 4 },
    { checkKey: "slow_response", priority: "HIGH" as const, affectedPages: 1 },
  ] };
  const c = compareMonths(curr, prev);
  assert.equal(c.scoreDelta, 8);
  assert.deepEqual(c.newChecks.map((x) => x.checkKey), ["slow_response"]);
  assert.deepEqual(c.resolvedChecks.map((x) => [x.checkKey, x.before, x.after]), [["title_missing", 2, 0]]);
  assert.deepEqual(c.improved.map((x) => [x.checkKey, x.before, x.after]), [["image_alt_missing", 10, 4]]);
  assert.deepEqual(c.worsened.map((x) => x.checkKey), ["h1_missing"]);
  assert.equal(c.unchanged, 1);
  // The first month is not "everything is new".
  const first = compareMonths(curr, null);
  assert.equal(first.scoreDelta, null);
  assert.equal(first.newChecks.length + first.resolvedChecks.length + first.improved.length + first.worsened.length, 0);
  assert.deepEqual(alignToMonths([{ month: "2026-09" }], ["2026-08", "2026-09"]), [null, { month: "2026-09" }]);
});

test("snapshots are taken on scan completion and before maintenance prunes detail rows", () => {
  const engine = read("src/lib/seo/scan-engine.ts");
  const finalize = fnBody(engine, "async function finalizeScan");
  assert.ok(finalize.indexOf("await afterScanCompleted(scan.id, dealer.id)") > finalize.indexOf("await db.transaction"), "after the scan's rows are committed");
  const post = read("src/lib/seo/post-scan.ts");
  assert.ok(/try \{\s*await upsertMonthlySnapshot\(scanId\);\s*\} catch/.test(post), "failure-isolated: a completed scan stays completed");
  const maintenance = fnBody(read("src/lib/jobs/maintenance.ts"), "export async function runMaintenance");
  assert.ok(maintenance.indexOf("backfillMonthlySnapshots()") > 0 && maintenance.indexOf("backfillMonthlySnapshots()") < maintenance.indexOf("delete from seo_issues"), "backfill runs before pruning");
  const schema = read("src/lib/db/schema.ts");
  const table = schema.slice(schema.indexOf('pgTable(\n  "seo_monthly_snapshots"'), schema.indexOf('"issue_status"'));
  assert.ok(/uniqueIndex\("seo_monthly_snapshots_dealer_month_idx"\)\.on\(t\.dealershipId, t\.month\)/.test(table));
  assert.ok(!/scanId: bigint\("scan_id", \{ mode: "number" \}\)\s*\.notNull\(\)\s*\.references/.test(table), "the snapshot outlives its scan (no FK)");
});

/* ── 4. Issue workflow ──────────────────────────────────────────────── */

const st = (o: Partial<ReconcileInput> & { fingerprint: string }): ReconcileInput => ({ url: "https://www.x.example/service/", status: "fixed", verifiedAt: null, siteScope: false, ...o });

test("a fix is verified only by a full scan that evaluated the page; a fix still found is reopened", () => {
  const evaluated = new Set([urlKey("https://x.example/service")]);
  const full = { found: new Set(["still"]), fullScan: true, evaluatedUrlKeys: evaluated, siteEvaluated: true };
  const actions = reconcileFixedStates(
    [
      st({ fingerprint: "gone" }),
      st({ fingerprint: "still" }),
      st({ fingerprint: "elsewhere", url: "https://x.example/not-crawled" }),
      st({ fingerprint: "site", url: "https://x.example/sitemap.xml", siteScope: true }),
      st({ fingerprint: "open", status: "open" }),
      st({ fingerprint: "ign", status: "ignored" }),
      st({ fingerprint: "done", verifiedAt: new Date() }),
    ],
    full,
    urlKey,
  );
  assert.deepEqual(actions, [
    { fingerprint: "gone", action: "verify" },
    { fingerprint: "still", action: "reopen" },
    { fingerprint: "site", action: "verify" },
  ]);
  // A partial or blocked scan proves nothing about absent issues, but a found one is still found.
  const partial = reconcileFixedStates([st({ fingerprint: "gone" }), st({ fingerprint: "still" })], { ...full, fullScan: false, siteEvaluated: false }, urlKey);
  assert.deepEqual(partial, [{ fingerprint: "still", action: "reopen" }]);
  // A verified fix that comes back is reopened too.
  assert.deepEqual(reconcileFixedStates([st({ fingerprint: "still", verifiedAt: new Date() })], full, urlKey), [{ fingerprint: "still", action: "reopen" }]);
});

test("'came back' shows until someone re-decides, and statuses read honestly", () => {
  const fixedAt = new Date("2026-10-01T00:00:00Z");
  const reopened = { status: "open" as const, fixedMarkedAt: fixedAt, verifiedAt: null, reopenedAt: new Date("2026-10-05T00:00:00Z") };
  assert.equal(cameBack(reopened), true);
  assert.equal(describeState(reopened).label, "Came back");
  assert.equal(cameBack({ ...reopened, fixedMarkedAt: new Date("2026-10-06T00:00:00Z") }), false, "marked fixed again");
  assert.equal(describeState(null).label, "Open");
  assert.equal(describeState({ status: "fixed", fixedMarkedAt: fixedAt, verifiedAt: null, reopenedAt: null }).label, "Marked fixed");
  assert.equal(describeState({ status: "fixed", fixedMarkedAt: fixedAt, verifiedAt: new Date(), reopenedAt: null }).label, "Fixed · verified");
  assert.match(describeState({ status: "ignored", fixedMarkedAt: null, verifiedAt: null, reopenedAt: null }).detail ?? "", /still counted in the score/i);
  const now = new Date();
  assert.deepEqual(applyStatusChange("fixed", now), { status: "fixed", fixedMarkedAt: now, verifiedAt: null, reopenedAt: null });
  assert.equal(applyStatusChange("in_progress", now).reopenedAt, null);
  assert.equal(parseWorkflowFilter("reopened"), "reopened");
  assert.equal(parseWorkflowFilter("drop table"), null);
});

test("ignored issues leave 'what to do next' lists but the score never reads workflow state", () => {
  assert.equal(isActionable({ findings: 3 }, 3), false, "every finding ignored → left out");
  assert.equal(isActionable({ findings: 3 }, 2), true, "some still need doing");
  assert.equal(isActionable({ findings: 3 }, 0), true);
  for (const f of ["src/lib/seo/scoring.ts", "src/lib/seo/checks/evaluate.ts", "src/lib/reports/findings.ts"]) {
    assert.ok(!/issue_states|issueStates|workflow/i.test(read(f)), `${f} must not read workflow state`);
  }
  // The scan engine only *reports* to the workflow, after the score is stored.
  const finalize = fnBody(read("src/lib/seo/scan-engine.ts"), "async function finalizeScan");
  assert.ok(!/issueStates|issue_states/.test(finalize));
  assert.ok(finalize.indexOf("computeScore(") < finalize.indexOf("afterScanCompleted("));
  const opp = read("src/lib/queries/client-opportunities.ts");
  assert.ok(/opts\.includeIgnored \? withWorkflow : withWorkflow\.filter\(\(o\) => isActionable\(o, o\.ignoredFindings\)\)/.test(opp));
});

test("only admins change workflow status, and only on their dealership's own issues", () => {
  const action = fnBody(read("src/app/actions/issues.ts"), "export async function updateIssueStateAction");
  assert.ok(action.indexOf("await assertAdmin()") < action.indexOf("setIssueStates"), "admin check first");
  assert.ok(/await assertDealershipAccess\(v\.id\)/.test(action));
  assert.ok(/resolveTargets\(v\.id, latest\.id/.test(action), "targets come from the dealership's own scan, not the browser");
  assert.ok(/back\.startsWith\(`\/dealerships\/\$\{v\.id\}`\)/.test(action), "no open redirect");
  const states = fnBody(read("src/lib/issues/states.ts"), "export async function resolveTargets");
  assert.ok(/eq\(seoIssues\.dealershipId, dealershipId\), eq\(seoIssues\.scanId, scanId\)/.test(states));
  const page = read("src/app/(app)/dealerships/[id]/page.tsx");
  assert.ok(/canEdit=\{user\.role === "admin"\}/.test(page), "viewers and clients are read-only");
  assert.ok(/\{canEdit && <IssueWorkflowEditor/.test(page));
});

/* ── 5. Branding ────────────────────────────────────────────────────── */

test("brand colours are #RRGGBB only", () => {
  assert.equal(normalizeBrandColor("#0f2747"), "#0F2747");
  assert.equal(normalizeBrandColor(" #ABCDEF "), "#ABCDEF");
  for (const bad of ["0F2747", "#FFF", "#GGGGGG", "red", "#0F2747;background:url(x)", "", null]) assert.equal(normalizeBrandColor(bad), null, String(bad));
});

test("logo URLs must be https on a named public host", () => {
  assert.deepEqual(checkLogoUrlShape("https://cdn.dealer.example/logo.png#x"), { ok: true, url: "https://cdn.dealer.example/logo.png" });
  for (const bad of [
    "http://cdn.dealer.example/logo.png",
    "https://user:pw@cdn.dealer.example/logo.png",
    "https://cdn.dealer.example:8443/logo.png",
    "https://127.0.0.1/logo.png",
    "https://[::1]/logo.png",
    "https://localhost/logo.png",
    "https://intranet/logo.png",
    "https://printer.local/logo.png",
    "javascript:alert(1)",
    `https://cdn.dealer.example/${"a".repeat(600)}.png`,
  ]) {
    assert.equal(checkLogoUrlShape(bad).ok, false, bad);
  }
  const service = read("src/lib/dealerships/service.ts");
  assert.ok(/await assertSafeUrl\(shape\.url\)/.test(service), "the host is resolved through the SSRF guard (the PDF worker fetches it)");
});

test("header text is always the more readable of white and black", () => {
  assert.equal(textColorOn("#0F2747"), "#FFFFFF");
  assert.equal(textColorOn("#FFD200"), "#000000");
  assert.equal(textColorOn("#FFFFFF"), "#000000");
  // Max(contrast with white, contrast with black) is ≥ 4.58 for every colour, so the
  // chosen text always meets WCAG AA for normal text.
  for (let r = 0; r <= 255; r += 51) for (let g = 0; g <= 255; g += 51) for (let b = 0; b <= 255; b += 51) {
    const hex = `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
    assert.ok(contrastRatio(hex, textColorOn(hex)) >= 4.5, hex);
  }
  const fallback = resolveBranding({ brandColor: null, logoUrl: null });
  assert.equal(fallback.color, A3_BRAND_COLOR);
  assert.equal(fallback.custom, false);
  assert.equal(resolveBranding({ brandColor: "nope", logoUrl: "http://insecure.example/x.png" }).custom, false, "invalid input falls back to A3 styling");
});

/* ── 6. Monthly email ──────────────────────────────────────────────── */

const monthlyInput = (over: Partial<MonthlyReportEmailInput> = {}): MonthlyReportEmailInput => ({
  dealershipName: "Sample <Motors>",
  websiteUrl: "https://www.sample.example/",
  monthLabel: "October 2026",
  score: 82,
  statusLabel: "Completed",
  pagesAnalyzed: 40,
  pagesProtected: 0,
  counts: { critical: 1, high: 2, medium: 3, low: 4 },
  executiveSummary: "The site is in fair shape.",
  actions: [{ priority: "CRITICAL", title: "Add page titles", action: "Write a unique title for each page." }],
  comparison: { previousMonthLabel: "September 2026", gap: false, previousScore: 76, scoreDelta: 6, newIssues: [{ title: "Slow pages", priority: "HIGH", before: 0, after: 2 }], resolvedIssues: [], improved: [], worsened: [] },
  detailsRetained: true,
  pdf: "attached",
  reportUrl: "https://seo.example/report/9",
  dashboardUrl: "https://seo.example/dealerships/9?tab=reports&report=4",
  ...over,
});

test("the monthly email states the attachment honestly and links to sign-in when there is none", () => {
  const withPdf = renderMonthlyReportEmail(monthlyInput());
  assert.match(withPdf.html, /attached as a PDF/);
  assert.ok(!withPdf.html.includes("Sign in to view the report"));
  const without = renderMonthlyReportEmail(monthlyInput({ pdf: "download" }));
  assert.match(without.html, /Sign in to view the report and download the PDF/);
  assert.ok(without.html.includes('href="https://seo.example/report/9"'));
  assert.match(without.text, /could not be attached/);
  for (const e of [withPdf, without]) {
    assert.ok(!/[?&]rt=|token/i.test(e.html + e.text), "never a render key in an email");
    assert.ok(e.html.includes("Sample &lt;Motors&gt;") && !e.html.includes("Sample <Motors>"), "escaped");
    assert.match(e.html, /name="viewport"/);
    assert.match(e.subject, /Monthly SEO report — October 2026: Sample <Motors> · 82\/100 \(\+6\)/);
  }
});

test("the monthly email discloses pruned detail and a missing comparison month", () => {
  const pruned = renderMonthlyReportEmail(monthlyInput({ detailsRetained: false }));
  assert.match(pruned.html, /no longer retained/);
  assert.match(pruned.text, /no longer retained/);
  const first = renderMonthlyReportEmail(monthlyInput({ comparison: null }));
  assert.match(first.html, /no month-over-month comparison yet/);
  assert.ok(!/\(\+/.test(first.subject), "no delta without a comparison");
  const gap = renderMonthlyReportEmail(monthlyInput({ comparison: { ...monthlyInput().comparison!, previousMonthLabel: "August 2026", gap: true } }));
  assert.match(gap.html, /No full check of the website was stored for the month in between/);
  const test = renderMonthlyReportEmail(monthlyInput({ test: true }));
  assert.ok(test.subject.startsWith("[Test] "));
});

test("dealership branding reaches the email header with readable text; A3 styling otherwise", () => {
  const branded = renderMonthlyReportEmail(monthlyInput({ branding: { ...resolveBranding({ brandColor: "#FFD200", logoUrl: "https://cdn.dealer.example/logo.png" }), logoAlt: "Sample" } }));
  assert.ok(branded.html.includes("background:#FFD200"));
  assert.ok(branded.html.includes("color:#000000;font-size:20px"), "black title on yellow");
  assert.ok(branded.html.includes('<img src="https://cdn.dealer.example/logo.png" alt="Sample"'));
  const plain = renderReportEmail({ dealershipName: "D", websiteUrl: "https://d.example", score: 1, statusLabel: "x", pagesAnalyzed: 1, pagesProtected: 0, executiveSummary: "s", actions: [], protectedPagesNote: null, newsSummary: null, reportUrl: "https://a", dashboardUrl: "https://b" });
  assert.ok(plain.html.includes("background:#0f2747") && plain.html.includes("color:#93c5fd"), "default A3 header unchanged");
  assert.ok(!plain.html.includes("<img"));
});

test("both providers pass attachments through; the console provider only logs them", async () => {
  const src = read("src/lib/email/provider.ts");
  assert.equal(src.match(/\.\.\.\(m\.attachments\?\.length \? \{ attachments: m\.attachments\.map/g)?.length, 2, "Resend and SMTP");
  process.env.DATABASE_URL ??= "postgres://unused.invalid/db";
  process.env.AUTH_SECRET ??= "x".repeat(32);
  process.env.CRON_SECRET ??= "y".repeat(32);
  process.env.EMAIL_PROVIDER = "console";
  const { getEmailProvider } = await import("@/lib/email/provider");
  const provider = getEmailProvider();
  assert.equal(provider.name, "console", "tests never send real email");
  const logged: string[] = [];
  const original = console.log;
  console.log = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await provider.send({ to: "gm@example.invalid", subject: "s", html: "<p>h</p>", text: "t", attachments: [{ filename: "Report.pdf", content: Buffer.from("%PDF-1.7 test"), contentType: "application/pdf" }] });
  } finally {
    console.log = original;
  }
  assert.match(logged.join("\n"), /Attachments: Report\.pdf \(application\/pdf, 13 bytes\)/);
});

test("the monthly job never puts the PDF worker's key in the email and keeps the PDF for retries", () => {
  const job = read("src/lib/reports/monthly.ts");
  // Only the TTL constant is imported from render-token; the key itself is never handled here.
  assert.ok(!/token|\?rt=/i.test(job.replace(/RENDER_TOKEN_TTL_MS/g, "").replace('"./render-token"', "")), "the render key stays in the report_pdf job only");
  assert.ok(/requestReportPdf\(dealer\.id, payload\.requestedBy \?\? null, \{ reuseInFlight: false \}\)/.test(job), "its own render, never someone's download");
  assert.ok(job.indexOf("peekRenderedPdf") < job.indexOf("discardRender(payload.renderId, dealer.id).catch"), "bytes are only discarded after every recipient is served");
  assert.ok(/if \(out\.failed > 0\) throw new Error/.test(job), "failed recipients are retried by the job");
  assert.ok(/reportUrl: `\$\{base\}\/report\/\$\{dealer\.id\}`/.test(job), "a plain sign-in link");
  const action = fnBody(read("src/app/actions/monthly-report.ts"), "export async function sendMonthlyReportNowAction");
  assert.ok(action.indexOf("await assertAdmin()") < action.indexOf("enqueueJob"), "admin only");
});

/* ── 7. Onboarding ──────────────────────────────────────────────────── */

const blank: GettingStartedState = { dealerships: 0, completedScans: 0, managementRecipients: 0, dealershipsWithRecipients: 0, emailProblem: "Email is in development mode", pageSpeedKey: false, aiKey: false };

test("the getting-started checklist reflects real state and links to each fix", () => {
  const items = gettingStartedItems(blank);
  assert.deepEqual(items.map((i) => i.key), ["dealerships", "scan", "recipients", "email", "pagespeed", "ai"]);
  assert.ok(items.every((i) => !i.done && i.href.startsWith("/")));
  assert.equal(items.find((i) => i.key === "email")!.detail, "Email is in development mode", "the real configuration problem is shown");
  assert.equal(checklistComplete(items), false);
  const ready = gettingStartedItems({ dealerships: 3, completedScans: 1, managementRecipients: 0, dealershipsWithRecipients: 2, emailProblem: null, pageSpeedKey: false, aiKey: false });
  assert.equal(ready.find((i) => i.key === "recipients")!.done, true, "dealership contacts count as recipients");
  assert.equal(checklistComplete(ready), true, "optional integrations never hold the checklist open");
});

test("dealership logins get a dismissible welcome guide that stays reachable from Help and Account", () => {
  const layout = read("src/app/(app)/layout.tsx");
  assert.ok(/isClient\(user\) && !\(await hasDismissedWelcome\(user\.id\)\)/.test(layout), "first visit of a client only");
  assert.ok(layout.includes('{ href: "/help", label: "Help", icon: "help" }'));
  assert.ok(read("src/app/(app)/account/page.tsx").includes('href="/help"'));
  const action = read("src/app/actions/onboarding.ts");
  assert.ok(/const user = await assertUser\(\);\s*await markWelcomeDismissed\(user\.id\)/.test(action), "only the caller's own row");
  const guide = read("src/components/welcome-guide.tsx");
  for (const topic of ["score", "Opportunities", "could not check", "Reports and PDF", "Email"]) assert.ok(guide.includes(topic), topic);
});
