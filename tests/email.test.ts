import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAlertEmail, renderDigestEmail } from "@/lib/email/templates";

test("alert email renders with the local timezone", () => {
  const r = renderAlertEmail({ title: "X: website unavailable", message: "Down <b>now</b>", dealershipName: "X", websiteUrl: "https://x.com", reportUrl: "https://app/d/1", dashboardUrl: "https://app", detectedAt: new Date("2026-09-11T02:48:46Z"), timeZone: "America/Chicago" });
  assert.match(r.text, /Sep 10, 2026, 9:48\s?PM CDT/);
  assert.ok(r.html.includes("Down &lt;b&gt;now&lt;/b&gt;"), "message is HTML-escaped");
  assert.ok(r.html.includes("View Dashboard"));
});

test("digest email renders required sections", () => {
  const r = renderDigestEmail({
    kind: "daily",
    periodLabel: "Changes in the last 24 hours",
    dashboardUrl: "https://app",
    dealers: [{ id: 1, name: "BMW of Fort Walton Beach", brand: "BMW", score: 87, scoreDelta: -3, critical: 2, warnings: 5, newCritical: 1, newWarnings: 2, resolved: 3, newNews: 4, newsHeadlines: [], topIssues: [{ label: "Missing meta descriptions", count: 6, severity: "warning" }], changes: [], siteAvailable: true, scanStatus: "Partially blocked", notEvaluated: 4, limitedCheck: false, lastScanAt: null, reportUrl: "https://app/d/1", hasChanges: true }],
  });
  assert.match(r.text, /SEO Score: 87\/100/);
  assert.match(r.text, /Critical Issues: 2/);
  assert.match(r.text, /Resolved: 3/);
  assert.match(r.text, /1\. Missing meta descriptions/);
  assert.match(r.text, /View Dashboard: https:\/\/app/);
  assert.match(r.text, /Scan status: Partially blocked/);
  assert.match(r.text, /Not evaluated \(access restricted, NOT SEO problems\): 4 page/);
  assert.match(r.html, /These are <strong>not<\/strong> SEO problems/);
});
