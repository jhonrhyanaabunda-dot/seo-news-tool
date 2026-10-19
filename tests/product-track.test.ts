import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { alignToMonths, compareMonths, isSnapshotEligible, monthLabel, monthOf, monthsEndingWith, previousMonth, replacesSnapshot, summarizeChecks } from "@/lib/history/monthly";
import { applyStatusChange, cameBack, describeState, isActionable, parseWorkflowFilter, reconcileFixedStates, type ReconcileInput } from "@/lib/issues/workflow";
import { urlKey } from "@/lib/seo/checks/evaluate";
import { A3_BRAND_COLOR, checkLogoUrlShape, contrastRatio, normalizeBrandColor, resolveBranding, textColorOn } from "@/lib/dealerships/branding";
import { checklistComplete, gettingStartedItems, type GettingStartedState } from "@/lib/onboarding/checklist";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const fnBody = (src: string, signature: string) => {
  const from = src.slice(src.indexOf(signature));
  return from.slice(0, from.indexOf("\n}\n") + 2);
};

/* ── 2. Monthly report schedule ─────────────────────────────────────── */

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
