import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderDigestEmail, type DigestDealer } from "@/lib/email/templates";
import { parseEmailList } from "@/lib/security/sanitize";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

/**
 * Stage 4D. An email is the one surface that reaches a dealership without them
 * asking, so the failure that matters is not a broken layout — it is an email
 * that says something the product cannot support: a score change with no
 * previous scan, a finding order that disagrees with the dashboard, a news date
 * that is really the date we noticed it, or a "sent" that only means a provider
 * accepted the message.
 */

function dealer(over: Partial<DigestDealer> = {}): DigestDealer {
  return {
    id: 1,
    name: "BMW of Fort Walton Beach",
    brand: "BMW",
    score: 87,
    scoreDelta: -3,
    critical: 2,
    warnings: 5,
    newCritical: 1,
    newWarnings: 2,
    resolved: 3,
    newNews: 0,
    newsHeadlines: [],
    topIssues: [{ label: "Missing page titles", priority: "CRITICAL", scope: "4 pages affected" }],
    openOpportunities: 1,
    detailsRetained: true,
    changes: [],
    siteAvailable: true,
    scanStatus: "Completed",
    notEvaluated: 0,
    limitedCheck: false,
    lastScanAt: new Date("2026-10-07T13:00:00Z"),
    reportUrl: "https://app.example/dealerships/1",
    hasChanges: true,
    ...over,
  };
}
const render = (d: Partial<DigestDealer>) => renderDigestEmail({ kind: "daily", periodLabel: "Changes in the last 24 hours", dashboardUrl: "https://app.example", dealers: [dealer(d)] });

/* ── Finding order and wording ──────────────────────────────────────── */

test("email uses the product's priority ordering, not its own", () => {
  // The digest used to sort by severity then count, which could put a
  // different issue first from the one the dashboard showed.
  const src = read("src/lib/email/reports.ts");
  assert.ok(src.includes("getOpportunities"), "the shared ordered list is reused");
  assert.ok(!/case when .*severity.* = 'critical' then 0 else 1 end/.test(src), "the old severity ordering must be gone");
  assert.ok(!/\.orderBy\(sql`case when/.test(src));
});

test("findings are shown with their priority word and real scope", () => {
  const r = render({});
  assert.match(r.text, /\[Critical\] Missing page titles \(4 pages affected\)/);
  assert.match(r.html, /Critical/);
  assert.ok(!/\(4 found\)/.test(r.text), "the old count-only wording is gone");
});

test("omitted findings are disclosed, never implied away", () => {
  const r = render({ topIssues: [{ label: "A", priority: "HIGH", scope: "2 pages affected" }], openOpportunities: 9 });
  assert.match(r.text, /and 8 more in the dashboard/);
  assert.match(r.html, /and 8 more in the dashboard/);
});

test("no 'more' line when everything is shown", () => {
  const r = render({ openOpportunities: 1 });
  assert.ok(!/more in the dashboard/.test(r.text));
});

/* ── Score comparisons ──────────────────────────────────────────────── */

test("a score change is only shown when a real comparison exists", () => {
  assert.match(render({ score: 87, scoreDelta: -3 }).html, /\(-3\)/);
  const none = render({ score: 87, scoreDelta: null });
  assert.ok(!/\(\+?-?\d+\)/.test(none.html.replace(/87\/100/g, "")), "no delta is fabricated when there is no previous scan");
});

test("an unscored or unreachable site is not given a number", () => {
  assert.match(render({ score: null, scoreDelta: null }).html, /Not scored yet/);
  assert.match(render({ siteAvailable: false }).html, /Website unavailable/);
});

/* ── Pruned scans ───────────────────────────────────────────────────── */

test("counts without retained findings are disclosed", () => {
  const r = render({ detailsRetained: false, critical: 2, warnings: 5, topIssues: [], openOpportunities: 0 });
  for (const body of [r.html, r.text]) {
    assert.match(body, /no longer retained/i);
    assert.match(body, /totals above remain accurate/i);
  }
});

test("a clean scan is not mistaken for a pruned one", () => {
  const r = render({ detailsRetained: false, critical: 0, warnings: 0, topIssues: [], openOpportunities: 0 });
  assert.ok(!/no longer retained/i.test(r.text), "nothing to disclose when there was nothing to prune");
});

/* ── News dates ─────────────────────────────────────────────────────── */

test("news carries the publisher's date, never the date we noticed it", () => {
  const src = read("src/lib/email/reports.ts");
  assert.ok(/publishedAt: newsArticles\.publishedAt/.test(src), "the publication date is selected");
  const newsQuery = src.slice(src.indexOf("const news = await db"), src.indexOf("const news = await db") + 900);
  assert.ok(!/detectedAt: newsArticles\.detectedAt/.test(newsQuery), "detectedAt must not be carried into the email as a date");
});

test("a headline with a publication date shows it, one without shows only the source", () => {
  const dated = render({ newsHeadlines: [{ title: "BMW recalls", url: "https://x.test/a", source: "Reuters", publishedAt: new Date("2026-10-05T00:00:00Z"), publishedPrecision: "date" }] });
  assert.match(dated.html, /Reuters · Oct \d/);
  const undated = render({ newsHeadlines: [{ title: "BMW recalls", url: "https://x.test/a", source: "Reuters", publishedAt: null, publishedPrecision: null }] });
  assert.match(undated.html, /Reuters/);
  assert.ok(!/·/.test(undated.html.slice(undated.html.indexOf("Reuters"), undated.html.indexOf("Reuters") + 40)), "no separator when there is no date to show");
});

/* ── Recipients ─────────────────────────────────────────────────────── */

test("recipient parsing rejects the malformed and keeps the valid", () => {
  const r = parseEmailList("Good@Example.com, not-an-email, second@example.com;third@example.com");
  assert.deepEqual(r.valid, ["good@example.com", "second@example.com", "third@example.com"], "lowercased and split on , and ;");
  assert.deepEqual(r.invalid, ["not-an-email"]);
});

test("duplicates and blanks are dropped rather than emailed twice", () => {
  const r = parseEmailList("a@example.com, A@EXAMPLE.COM, , \n a@example.com");
  assert.deepEqual(r.valid, ["a@example.com"]);
  assert.deepEqual(r.invalid, []);
});

test("an over-long address is rejected", () => {
  const r = parseEmailList(`${"x".repeat(320)}@example.com`);
  assert.deepEqual(r.valid, []);
  assert.equal(r.invalid.length, 1);
});

test("a dealership saving an invalid address is refused", () => {
  const src = read("src/lib/dealerships/service.ts");
  assert.ok(/if \(emails\.invalid\.length\) return \{ ok: false/.test(src), "the save fails rather than storing a bad address");
  assert.ok(/notificationEmails: emails\.valid/.test(src), "only validated addresses are stored");
});

test("each dealership's email is addressed to one recipient at a time", () => {
  // The send loop is per-recipient, so one dealership's list can never be
  // handed another dealership's content in the same message.
  const src = read("src/lib/email/reports.ts");
  assert.ok(/for \(const to of recipients\)/.test(src), "alerts send one message per recipient");
  assert.ok(/for \(const \[email, list\] of byRecipient\)/.test(src), "digests are built per recipient");
});

/* ── Delivery status honesty ────────────────────────────────────────── */

test("provider acceptance is never reported as delivery", () => {
  const page = read("src/app/(app)/admin/system/page.tsx");
  assert.ok(page.includes("Accepted by provider"), "the label states what is actually known");
  assert.ok(!/>Sent</.test(page), "'Sent' overstates what SMTP can confirm");
  const q = read("src/lib/queries/system.ts");
  assert.ok(/"accepted" \| "failed" \| "retrying" \| "skipped" \| "queued"/.test(q), "no 'delivered' state is invented");
});

test("a failure with a retry still scheduled is not reported as final", () => {
  const q = read("src/lib/queries/system.ts");
  // Established from the keys, not guessed: every retryable email is keyed on
  // its job's dedupe key plus a recipient suffix.
  assert.ok(/j\.status in \('queued', 'running'\)/.test(q));
  assert.ok(/like j\.dedupe_key \|\| ':%'/.test(q), "the job-to-email relationship is matched explicitly");
});

test("the failure reason is in the row, not a hover tooltip", () => {
  const page = read("src/app/(app)/admin/system/page.tsx");
  assert.ok(/\{m\.error\} <\/div>|>\{m\.error\}</.test(page.replace(/\s+/g, " ")), "the error renders as text");
  assert.ok(!/title=\{m\.error/.test(page), "a tooltip is invisible on a phone and to a keyboard");
});

test("staff can see the failure count without scrolling", () => {
  const page = read("src/app/(app)/admin/system/page.tsx");
  assert.ok(page.includes("getEmailOutcomeCounts") || page.includes("emailCounts"), "counts are surfaced");
  assert.ok(/\?emails=\$\{key\}/.test(page) && /"failed", "Failed"/.test(page), "and failures can be filtered to");
});

/* ── Links and isolation ────────────────────────────────────────────── */

test("email links carry no credentials and rely on the destination guard", () => {
  const reports = read("src/lib/email/reports.ts");
  assert.ok(/reportUrl = \(id: number\) => `\$\{dashboardUrl\(\)\}\/dealerships\/\$\{id\}`/.test(reports), "a plain application URL");
  // A render key in an email would hand a forwarded message real access.
  for (const f of ["src/lib/email/reports.ts", "src/lib/email/templates.ts"]) {
    assert.ok(!/\?rt=|renderToken|mintRenderToken/.test(read(f)), `${f} must not embed a render key`);
  }
});

test("the destination still enforces dealership access", () => {
  assert.ok(read("src/app/(app)/dealerships/[id]/layout.tsx").includes("requireDealershipAccess"));
});

/* ── Safety ─────────────────────────────────────────────────────────── */

test("no credential can reach a log line or a delivery record", () => {
  // Reading a secret to configure the transport is required; what must never
  // happen is one being passed to the logger or stored on a delivery row.
  const SECRET = /SMTP_PASS|RESEND_API_KEY|AUTH_SECRET|apiKey|password/i;
  for (const f of ["src/lib/email/send.ts", "src/lib/email/reports.ts", "src/lib/email/provider.ts", "src/lib/queries/system.ts"]) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const call of src.match(/logger\.(info|warn|error|debug)\([^;]*\)/g) ?? []) {
      assert.ok(!SECRET.test(call), `${f}: a log call references a credential — ${call.slice(0, 80)}`);
    }
    for (const write of src.match(/\.(values|set)\(\{[^}]*\}/g) ?? []) {
      assert.ok(!SECRET.test(write), `${f}: a database write references a credential — ${write.slice(0, 80)}`);
    }
  }
});

test("the send path still records before it sends", () => {
  // Idempotency depends on the row existing before the provider is called.
  const send = read("src/lib/email/send.ts");
  const insertAt = send.indexOf(".insert(emailReports)");
  const sendAt = send.indexOf("getEmailProvider().send");
  assert.ok(insertAt > 0 && sendAt > insertAt, "the dedupe row is written first");
  assert.ok(/existing\.status === "sent" \|\| existing\.status === "skipped"/.test(send), "an already-settled key is never re-sent");
});
