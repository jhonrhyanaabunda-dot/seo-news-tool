import { escapeHtml } from "@/lib/security/sanitize";
import { SEO_TOPIC_LABELS } from "@/lib/news/seo-topics";

/**
 * Email templates: table-based HTML with inline styles (renders in Outlook,
 * Gmail, Apple Mail) plus a plain-text alternative for every message.
 */

const C = {
  brand: "#0f2747",
  accent: "#1d4ed8",
  text: "#1f2937",
  muted: "#6b7280",
  border: "#e5e7eb",
  bg: "#f3f4f6",
  critical: "#b91c1c",
  warning: "#b45309",
  good: "#047857",
};

export interface DigestDealer {
  id: number;
  name: string;
  brand: string;
  score: number | null;
  scoreDelta: number | null;
  critical: number;
  warnings: number;
  newCritical: number;
  newWarnings: number;
  resolved: number;
  newNews: number;
  newsHeadlines: Array<{ title: string; url: string; source: string | null }>;
  topIssues: Array<{ label: string; count: number; severity: string }>;
  changes: string[];
  siteAvailable: boolean | null;
  /** Scan status label (Completed, Partially blocked, Blocked, …). */
  scanStatus: string | null;
  /** Pages not evaluated because the website restricted access (never counted as SEO problems). */
  notEvaluated: number;
  /** Only a limited homepage check from an alternative source was possible. */
  limitedCheck: boolean;
  lastScanAt: Date | null;
  reportUrl: string;
  hasChanges: boolean;
}

function scoreColor(score: number | null) {
  if (score === null) return C.muted;
  if (score >= 85) return C.good;
  if (score >= 65) return C.warning;
  return C.critical;
}

const DEFAULT_FOOTER = "You receive this because your address is listed as a notification contact in the A3 SEO &amp; News Monitor. Emails are only sent when something meaningful changes.";

function layout(title: string, preheader: string, body: string, dashboardUrl: string, footerHtml = DEFAULT_FOOTER): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.text};">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid ${C.border};">
<tr><td style="background:${C.brand};padding:20px 28px;">
  <div style="color:#93c5fd;font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;">A3 SEO &amp; News Monitor</div>
  <div style="color:#ffffff;font-size:20px;font-weight:700;margin-top:4px;">${escapeHtml(title)}</div>
</td></tr>
<tr><td style="padding:24px 28px;">${body}</td></tr>
<tr><td style="padding:0 28px 28px;" align="center">
  <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:${C.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;border-radius:8px;">View Dashboard</a>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid ${C.border};color:${C.muted};font-size:12px;line-height:1.5;">
  ${footerHtml}
</td></tr>
</table></td></tr></table></body></html>`;
}

function stat(label: string, value: string | number, color = C.text) {
  return `<td style="padding:8px 10px;text-align:center;border:1px solid ${C.border};border-radius:6px;">
    <div style="font-size:20px;font-weight:700;color:${color};">${value}</div>
    <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em;">${label}</div></td>`;
}

function dealerBlock(d: DigestDealer): string {
  const delta =
    d.scoreDelta !== null && d.scoreDelta !== 0
      ? ` <span style="font-size:13px;color:${d.scoreDelta > 0 ? C.good : C.critical};">(${d.scoreDelta > 0 ? "+" : ""}${d.scoreDelta})</span>`
      : "";
  const scoreText = d.siteAvailable === false ? `<span style="color:${C.critical};">Website unavailable</span>` : d.score === null ? "Not scored yet" : `${d.score}/100${delta}`;
  const issues = d.topIssues.length
    ? `<div style="margin-top:12px;font-size:13px;font-weight:600;">Top issues</div><ol style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6;">${d.topIssues
        .map((i) => `<li><span style="color:${i.severity === "critical" ? C.critical : C.warning};">${escapeHtml(i.label)}</span> <span style="color:${C.muted};">(${i.count} found)</span></li>`)
        .join("")}</ol>`
    : "";
  const changes = d.changes.length
    ? `<div style="margin-top:12px;font-size:13px;font-weight:600;">Important changes</div><ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6;">${d.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
    : "";
  const news = d.newsHeadlines.length
    ? `<div style="margin-top:12px;font-size:13px;font-weight:600;">New relevant news</div><ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6;">${d.newsHeadlines
        .map((n) => `<li><a href="${escapeHtml(n.url)}" style="color:${C.accent};">${escapeHtml(n.title)}</a>${n.source ? ` <span style="color:${C.muted};">— ${escapeHtml(n.source)}</span>` : ""}</li>`)
        .join("")}</ul>`
    : "";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border:1px solid ${C.border};border-radius:8px;"><tr><td style="padding:16px 18px;">
  <div style="font-size:17px;font-weight:700;"><a href="${escapeHtml(d.reportUrl)}" style="color:${C.brand};text-decoration:none;">${escapeHtml(d.name)}</a></div>
  <div style="font-size:14px;margin-top:4px;">SEO Score: <strong style="color:${scoreColor(d.score)};">${scoreText}</strong></div>
  ${d.scanStatus ? `<div style="font-size:13px;margin-top:2px;color:${C.muted};">Scan status: <strong style="color:${d.scanStatus === "Completed" ? C.good : C.warning};">${escapeHtml(d.scanStatus)}</strong></div>` : ""}
  ${
    d.notEvaluated > 0 || d.limitedCheck
      ? `<div style="margin-top:10px;padding:10px 12px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;font-size:13px;color:#92400e;">⚠️ <strong>Not evaluated — access restricted.</strong> ${
          d.limitedCheck
            ? "The website restricted automated access. Only a limited homepage check from an alternative source (Google PageSpeed Insights) is included."
            : `${d.notEvaluated} page(s) could not be evaluated because the website restricted automated access.`
        } These are <strong>not</strong> SEO problems.</div>`
      : ""
  }
  <table role="presentation" cellpadding="0" cellspacing="6" style="margin-top:10px;"><tr>
    ${stat("Critical", d.critical, d.critical ? C.critical : C.text)}
    ${stat("Warnings", d.warnings, d.warnings ? C.warning : C.text)}
    ${stat("New critical", d.newCritical, d.newCritical ? C.critical : C.text)}
    ${stat("New warnings", d.newWarnings)}
    ${stat("Resolved", d.resolved, d.resolved ? C.good : C.text)}
    ${stat("New news", d.newNews)}
  </tr></table>
  ${issues}${changes}${news}
  <div style="margin-top:12px;"><a href="${escapeHtml(d.reportUrl)}" style="font-size:13px;color:${C.accent};">Open full report →</a></div>
</td></tr></table>`;
}

export interface DigestSeoStory {
  title: string;
  url: string;
  source: string;
  summary: string | null;
  publishedAt: Date | null;
  topics: string[];
}

const NEWSLETTER_FOOTER =
  "You receive this weekly newsletter because your address is listed as a recipient in the A3 SEO &amp; News Monitor. SEO news is taken from the publications’ public RSS feeds; follow a headline to read the full article on the publisher’s site.";

function storyDate(d: Date | null, timeZone: string) {
  return d ? new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(d) : null;
}

function seoStoriesBlock(stories: DigestSeoStory[], timeZone: string, seoNewsUrl: string): string {
  if (!stories.length) return "";
  const items = stories
    .map((s) => {
      const meta = [escapeHtml(s.source), storyDate(s.publishedAt, timeZone)].filter(Boolean).join(" · ");
      const topics = s.topics
        .filter((t) => SEO_TOPIC_LABELS[t])
        .map((t) => `<span style="display:inline-block;background:#eff6ff;color:${C.accent};font-size:11px;font-weight:600;padding:1px 7px;border-radius:999px;margin:0 4px 0 0;">${escapeHtml(SEO_TOPIC_LABELS[t])}</span>`)
        .join("");
      const summary = s.summary ? `<div style="font-size:13px;line-height:1.5;color:${C.text};margin-top:3px;">${escapeHtml(s.summary.length > 220 ? `${s.summary.slice(0, 217).trimEnd()}…` : s.summary)}</div>` : "";
      return `<tr><td style="padding:12px 0;border-top:1px solid ${C.border};">
    <a href="${escapeHtml(s.url)}" style="font-size:15px;font-weight:700;color:${C.brand};text-decoration:none;line-height:1.35;">${escapeHtml(s.title)}</a>
    <div style="font-size:12px;color:${C.muted};margin-top:3px;">${meta}${topics ? ` &nbsp;${topics}` : ""}</div>${summary}
  </td></tr>`;
    })
    .join("");
  return `<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${C.accent};margin:0 0 4px;">This week in SEO</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">${items}</table>
  <div style="margin:0 0 26px;"><a href="${escapeHtml(seoNewsUrl)}" style="font-size:13px;color:${C.accent};">All SEO news →</a></div>`;
}

export function renderDigestEmail(input: {
  kind: "daily" | "weekly";
  periodLabel: string;
  dealers: DigestDealer[];
  dashboardUrl: string;
  /** Weekly newsletter only: the week's top SEO industry stories. */
  seoStories?: DigestSeoStory[];
  timeZone?: string;
}) {
  const weekly = input.kind === "weekly";
  const stories = weekly ? (input.seoStories ?? []) : [];
  const title = weekly ? "Weekly SEO Newsletter" : "Daily SEO & News Monitoring Report";
  const changed = input.dealers.filter((d) => d.hasChanges);
  const unchanged = input.dealers.filter((d) => !d.hasChanges);
  const totals = input.dealers.reduce((t, d) => ({ c: t.c + d.newCritical, r: t.r + d.resolved, n: t.n + d.newNews }), { c: 0, r: 0, n: 0 });
  const dealerSummary = `${changed.length} dealership${changed.length === 1 ? "" : "s"} with changes · ${totals.c} new critical · ${totals.r} resolved · ${totals.n} new news`;
  const preheader = stories.length ? `${stories[0].title} · ${dealerSummary}` : dealerSummary;

  const unchangedHtml = unchanged.length
    ? `<div style="font-size:14px;font-weight:600;margin:8px 0;">No meaningful changes</div>
       <table role="presentation" width="100%" cellpadding="6" cellspacing="0" style="font-size:13px;border-collapse:collapse;">${unchanged
         .map((d) => `<tr style="border-top:1px solid ${C.border};"><td><a href="${escapeHtml(d.reportUrl)}" style="color:${C.brand};">${escapeHtml(d.name)}</a></td><td align="right" style="color:${scoreColor(d.score)};font-weight:600;">${d.score ?? "—"}/100</td><td align="right" style="color:${C.muted};">${d.critical} critical · ${d.warnings} warnings</td></tr>`)
         .join("")}</table>`
    : "";

  const tz = input.timeZone ?? "UTC";
  const seoNewsUrl = `${input.dashboardUrl.replace(/\/$/, "")}/seo-news`;
  const dealersHeading =
    weekly && input.dealers.length ? `<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${C.accent};margin:0 0 12px;">Your dealerships this week</div>` : "";
  const body = `<p style="margin:0 0 18px;font-size:14px;color:${C.muted};">${escapeHtml(input.periodLabel)}</p>${seoStoriesBlock(stories, tz, seoNewsUrl)}${dealersHeading}${changed.map(dealerBlock).join("")}${unchangedHtml}`;

  const text = [
    title,
    input.periodLabel,
    "",
    ...(stories.length
      ? [
          "THIS WEEK IN SEO",
          ...stories.flatMap((s) => [
            `- ${s.title}`,
            `  ${[s.source, storyDate(s.publishedAt, tz), ...s.topics.map((t) => SEO_TOPIC_LABELS[t]).filter(Boolean)].filter(Boolean).join(" · ")}`,
            `  ${s.url}`,
          ]),
          `All SEO news: ${seoNewsUrl}`,
          "",
          ...(input.dealers.length ? ["YOUR DEALERSHIPS THIS WEEK", ""] : []),
        ]
      : []),
    ...changed.flatMap((d) => [
      d.name,
      `SEO Score: ${d.siteAvailable === false ? "Website unavailable" : d.score === null ? "not scored" : `${d.score}/100${d.scoreDelta ? ` (${d.scoreDelta > 0 ? "+" : ""}${d.scoreDelta})` : ""}`}`,
      ...(d.scanStatus ? [`Scan status: ${d.scanStatus}`] : []),
      ...(d.notEvaluated > 0 || d.limitedCheck
        ? [`Not evaluated (access restricted, NOT SEO problems): ${d.limitedCheck ? "only a limited homepage check from Google PageSpeed Insights" : `${d.notEvaluated} page(s)`}`]
        : []),
      `Critical Issues: ${d.critical} (new: ${d.newCritical})`,
      `Warnings: ${d.warnings} (new: ${d.newWarnings})`,
      `Resolved: ${d.resolved}`,
      `New News: ${d.newNews}`,
      ...(d.topIssues.length ? ["Top Issues:", ...d.topIssues.map((i, n) => `${n + 1}. ${i.label} (${i.count})`)] : []),
      ...(d.changes.length ? ["Important changes:", ...d.changes.map((c) => `- ${c}`)] : []),
      ...(d.newsHeadlines.length ? ["New relevant news:", ...d.newsHeadlines.map((h) => `- ${h.title} ${h.url}`)] : []),
      `Report: ${d.reportUrl}`,
      "",
    ]),
    ...(unchanged.length ? ["No meaningful changes:", ...unchanged.map((d) => `- ${d.name}: ${d.score ?? "—"}/100`), ""] : []),
    `View Dashboard: ${input.dashboardUrl}`,
  ].join("\n");

  const changedText = changed.length ? `${changed.length} dealership${changed.length === 1 ? "" : "s"} with changes` : null;
  const criticalText = totals.c ? `${totals.c} new critical` : null;
  const subjectParts = weekly
    ? [stories.length ? `${stories.length} top SEO stor${stories.length === 1 ? "y" : "ies"}` : null, input.dealers.length ? (changedText ?? "no dealership changes") : null, criticalText]
    : [changedText ?? "no changes", criticalText];
  const subject = `${title} — ${subjectParts.filter(Boolean).join(" · ") || "this week"}`;
  return { subject, html: layout(title, preheader, body, input.dashboardUrl, weekly ? NEWSLETTER_FOOTER : DEFAULT_FOOTER), text };
}

export function renderAlertEmail(input: { title: string; message: string; dealershipName: string; websiteUrl: string; reportUrl: string; dashboardUrl: string; detectedAt: Date; timeZone?: string }) {
  // dateStyle/timeStyle cannot be combined with timeZoneName, so spell the fields out.
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone: input.timeZone ?? "UTC",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(input.detectedAt);
  const lines = input.message.split("\n").filter(Boolean);
  const body = `
  <div style="display:inline-block;background:#fee2e2;color:${C.critical};font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em;">Critical alert</div>
  <h2 style="font-size:18px;margin:14px 0 6px;color:${C.brand};">${escapeHtml(input.dealershipName)}</h2>
  <div style="font-size:13px;color:${C.muted};margin-bottom:14px;"><a href="${escapeHtml(input.websiteUrl)}" style="color:${C.muted};">${escapeHtml(input.websiteUrl)}</a> · Detected ${escapeHtml(when)}</div>
  <div style="font-size:14px;line-height:1.6;">${lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}</div>
  <div style="margin-top:16px;"><a href="${escapeHtml(input.reportUrl)}" style="font-size:14px;color:${C.accent};font-weight:600;">Open dealership report →</a></div>`;
  const text = `${input.title}\n\n${input.dealershipName} (${input.websiteUrl})\nDetected: ${when}\n\n${input.message}\n\nReport: ${input.reportUrl}\nView Dashboard: ${input.dashboardUrl}`;
  return { subject: `⚠ ${input.title}`, html: layout(input.title, input.message.slice(0, 120), body, input.dashboardUrl), text };
}

export function renderTestEmail(dashboardUrl: string) {
  const body = `<p style="font-size:14px;line-height:1.6;margin:0;">This is a test message from the A3 SEO &amp; News Monitor. If you can read this, email delivery is configured correctly.</p>`;
  return {
    subject: "A3 SEO Monitor — test email",
    html: layout("Email delivery test", "Email delivery is working.", body, dashboardUrl),
    text: `This is a test message from the A3 SEO & News Monitor. Email delivery is configured correctly.\n\nView Dashboard: ${dashboardUrl}`,
  };
}

/** SEO report email: the grounded narrative plus the headline facts, with a link to the full report. */
export function renderReportEmail(input: {
  dealershipName: string;
  websiteUrl: string;
  score: number | null;
  statusLabel: string;
  pagesAnalyzed: number;
  pagesProtected: number;
  executiveSummary: string;
  actions: Array<{ priority: string; title: string; action: string }>;
  protectedPagesNote: string | null;
  newsSummary: string | null;
  reportUrl: string;
  dashboardUrl: string;
}) {
  const tone: Record<string, string> = { CRITICAL: C.critical, HIGH: C.warning, MEDIUM: C.accent, LOW: C.muted };
  const top = input.actions.slice(0, 5);
  const body = `
  <h2 style="font-size:18px;margin:0 0 6px;color:${C.brand};">${escapeHtml(input.dealershipName)} — SEO report</h2>
  <div style="font-size:13px;color:${C.muted};margin-bottom:14px;"><a href="${escapeHtml(input.websiteUrl)}" style="color:${C.muted};">${escapeHtml(input.websiteUrl)}</a></div>
  <div style="font-size:14px;margin-bottom:12px;"><strong>Score:</strong> ${input.score === null ? "Not scored" : `${input.score}/100`} · <strong>Status:</strong> ${escapeHtml(input.statusLabel)} · ${input.pagesAnalyzed} pages analyzed${input.pagesProtected ? ` · ${input.pagesProtected} protected` : ""}</div>
  <p style="font-size:14px;line-height:1.6;margin:0 0 16px;">${escapeHtml(input.executiveSummary)}</p>
  ${
    top.length
      ? `<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${C.muted};margin-bottom:6px;">Recommended actions</div>
  ${top.map((a) => `<div style="font-size:14px;line-height:1.5;margin-bottom:8px;"><span style="font-size:11px;font-weight:700;color:${tone[a.priority] ?? C.muted};">${escapeHtml(a.priority)}</span> <strong>${escapeHtml(a.title)}</strong><br>${escapeHtml(a.action)}</div>`).join("")}`
      : ""
  }
  ${input.protectedPagesNote ? `<p style="font-size:13px;color:${C.warning};line-height:1.5;">${escapeHtml(input.protectedPagesNote)}</p>` : ""}
  ${input.newsSummary ? `<p style="font-size:13px;color:${C.text};line-height:1.5;"><strong>News:</strong> ${escapeHtml(input.newsSummary)}</p>` : ""}
  <div style="margin-top:16px;"><a href="${escapeHtml(input.reportUrl)}" style="font-size:14px;color:${C.accent};font-weight:600;">Open the full report →</a></div>`;
  const text = [
    `${input.dealershipName} — SEO report`,
    input.websiteUrl,
    `Score: ${input.score === null ? "Not scored" : `${input.score}/100`} · Status: ${input.statusLabel} · ${input.pagesAnalyzed} pages analyzed${input.pagesProtected ? ` · ${input.pagesProtected} protected` : ""}`,
    "",
    input.executiveSummary,
    "",
    ...(top.length ? ["Recommended actions:", ...top.map((a) => `- [${a.priority}] ${a.title}: ${a.action}`), ""] : []),
    ...(input.protectedPagesNote ? [input.protectedPagesNote, ""] : []),
    ...(input.newsSummary ? [`News: ${input.newsSummary}`, ""] : []),
    `Full report: ${input.reportUrl}`,
  ].join("\n");
  return { subject: `SEO report: ${input.dealershipName}`, html: layout(`SEO report: ${input.dealershipName}`, input.executiveSummary.slice(0, 120), body, input.dashboardUrl), text };
}
