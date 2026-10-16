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
  newsHeadlines: Array<{ title: string; url: string; source: string | null; publishedAt: Date | null; publishedPrecision: string | null }>;
  /** The product's own priority ordering, shared with the dashboard and the report. */
  topIssues: Array<{ label: string; priority: string; scope: string }>;
  /** Total open opportunities, so the email can say what it is not showing. */
  openOpportunities: number;
  /** False once this scan's individual findings have been pruned. */
  detailsRetained: boolean;
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

/**
 * Header colours for a single-dealership email (see dealerships/branding.ts).
 * Omitted: A3's own header. Text colour is chosen for contrast by the caller's
 * `resolveBranding`, never taken from input.
 */
export interface EmailBranding {
  color: string;
  text: string;
  subtle: string;
  logoUrl: string | null;
  /** Alt text for the logo, e.g. the dealership name. */
  logoAlt?: string;
}

function header(title: string, brand?: EmailBranding): string {
  const bg = brand?.color ?? C.brand;
  const fg = brand?.text ?? "#ffffff";
  const eyebrow = brand?.subtle ?? "#93c5fd";
  const logo = brand?.logoUrl
    ? `<img src="${escapeHtml(brand.logoUrl)}" alt="${escapeHtml(brand.logoAlt ?? "")}" height="40" style="display:block;height:40px;width:auto;max-width:200px;border:0;margin:0 0 12px;">`
    : "";
  return `<tr><td style="background:${bg};padding:20px 28px;">
  ${logo}<div style="color:${eyebrow};font-size:12px;letter-spacing:.08em;text-transform:uppercase;font-weight:600;">A3 SEO &amp; News Monitor</div>
  <div style="color:${fg};font-size:20px;font-weight:700;margin-top:4px;">${escapeHtml(title)}</div>
</td></tr>`;
}

function layout(title: string, preheader: string, body: string, dashboardUrl: string, footerHtml = DEFAULT_FOOTER, brand?: EmailBranding, buttonLabel = "View Dashboard"): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>@media only screen and (max-width:480px){.tile{display:block!important;width:100%!important;}}</style></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:${C.text};">
<span style="display:none!important;visibility:hidden;opacity:0;height:0;width:0;overflow:hidden;">${escapeHtml(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 12px;"><tr><td align="center">
<table role="presentation" width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid ${C.border};">
${header(title, brand)}
<tr><td style="padding:24px 28px;">${body}</td></tr>
<tr><td style="padding:0 28px 28px;" align="center">
  <a href="${escapeHtml(dashboardUrl)}" style="display:inline-block;background:${C.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 28px;border-radius:8px;">${escapeHtml(buttonLabel)}</a>
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

function dealerBlock(d: DigestDealer, timeZone: string): string {
  const delta =
    d.scoreDelta !== null && d.scoreDelta !== 0
      ? ` <span style="font-size:13px;color:${d.scoreDelta > 0 ? C.good : C.critical};">(${d.scoreDelta > 0 ? "+" : ""}${d.scoreDelta})</span>`
      : "";
  const scoreText = d.siteAvailable === false ? `<span style="color:${C.critical};">Website unavailable</span>` : d.score === null ? "Not scored yet" : `${d.score}/100${delta}`;
  // Priority is carried by the word as well as the colour, so the list still
  // reads in a plain-text client or on a mono display.
  const priorityColour: Record<string, string> = { CRITICAL: C.critical, HIGH: C.warning, MEDIUM: C.warning, LOW: C.muted };
  const more = d.openOpportunities - d.topIssues.length;
  // Counts without findings behind them must say so; the totals are still exact.
  const pruned =
    !d.detailsRetained && d.critical + d.warnings > 0
      ? `<div style="margin-top:12px;font-size:13px;color:${C.muted};">Detailed records for this check are no longer retained. The totals above remain accurate, but the individual findings are not available to list here.</div>`
      : "";
  const issues = d.topIssues.length
    ? `<div style="margin-top:12px;font-size:13px;font-weight:600;">What to do next</div><ol style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6;">${d.topIssues
        .map(
          (i) =>
            `<li><span style="color:${priorityColour[i.priority] ?? C.muted};font-weight:600;">${escapeHtml(priorityWord(i.priority))}</span> — ${escapeHtml(i.label)} <span style="color:${C.muted};">(${escapeHtml(i.scope)})</span></li>`,
        )
        .join("")}</ol>${more > 0 ? `<div style="margin-top:4px;font-size:12px;color:${C.muted};">and ${more} more in the dashboard</div>` : ""}`
    : "";
  const changes = d.changes.length
    ? `<div style="margin-top:12px;font-size:13px;font-weight:600;">Important changes</div><ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6;">${d.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>`
    : "";
  const news = d.newsHeadlines.length
    ? `<div style="margin-top:12px;font-size:13px;font-weight:600;">New relevant news</div><ul style="margin:6px 0 0 18px;padding:0;font-size:13px;line-height:1.6;">${d.newsHeadlines
        .map((n) => {
          const meta = [n.source, storyDate(n.publishedAt, timeZone)].filter(Boolean).join(" · ");
          return `<li><a href="${escapeHtml(n.url)}" style="color:${C.accent};">${escapeHtml(n.title)}</a>${meta ? ` <span style="color:${C.muted};">— ${escapeHtml(meta)}</span>` : ""}</li>`;
        })
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
  ${pruned}${issues}${changes}${news}
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

/** "CRITICAL" → "Critical", so the priority reads as a word rather than a shout. */
function priorityWord(p: string): string {
  return p.charAt(0) + p.slice(1).toLowerCase();
}

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
  const body = `<p style="margin:0 0 18px;font-size:14px;color:${C.muted};">${escapeHtml(input.periodLabel)}</p>${seoStoriesBlock(stories, tz, seoNewsUrl)}${dealersHeading}${changed.map((d) => dealerBlock(d, tz)).join("")}${unchangedHtml}`;

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
      ...(!d.detailsRetained && d.critical + d.warnings > 0
        ? ["Detailed records for this check are no longer retained. The totals above remain accurate, but the individual findings are not available to list here."]
        : []),
      ...(d.topIssues.length ? ["What to do next:", ...d.topIssues.map((i, n) => `${n + 1}. [${priorityWord(i.priority)}] ${i.label} (${i.scope})`)] : []),
      ...(d.openOpportunities > d.topIssues.length ? [`   and ${d.openOpportunities - d.topIssues.length} more in the dashboard`] : []),
      ...(d.changes.length ? ["Important changes:", ...d.changes.map((c) => `- ${c}`)] : []),
      ...(d.newsHeadlines.length
        ? ["New relevant news:", ...d.newsHeadlines.map((h) => `- ${h.title}${[h.source, storyDate(h.publishedAt, tz)].filter(Boolean).length ? ` (${[h.source, storyDate(h.publishedAt, tz)].filter(Boolean).join(" · ")})` : ""}\n  ${h.url}`)]
        : []),
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

/** Crawler availability notice: scans are waiting with no crawler online, or crawling has resumed. */
export function renderCrawlerStatusEmail(input: {
  status: "offline" | "online";
  regions: string[];
  waitingScans: number;
  /** When the oldest waiting scan was queued (offline) or when the outage was first reported (online). */
  since: Date;
  /** The most recently seen crawler, e.g. "crawler-us-east-MacBook-Pro.local-4921". */
  lastCrawler: { id: string; lastSeenAt: Date } | null;
  systemUrl: string;
  dashboardUrl: string;
  timeZone?: string;
}) {
  const tz = input.timeZone ?? "UTC";
  const when = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(d);
  const regions = input.regions.join(", ");
  const offline = input.status === "offline";
  const title = offline ? "SEO scans are waiting: no crawler online" : "Crawler back online: SEO scans are running again";
  const lines = offline
    ? [
        `${input.waitingScans} SEO scan${input.waitingScans === 1 ? " is" : "s are"} queued for ${regions}, the oldest since ${when(input.since)}, but no crawler worker is online to run ${input.waitingScans === 1 ? "it" : "them"}.`,
        input.lastCrawler ? `Last crawler seen: ${input.lastCrawler.id}, at ${when(input.lastCrawler.lastSeenAt)}.` : "No crawler has reported recently.",
        "Queued scans are kept and run as soon as a crawler is back — nothing is lost, but dealership results will not refresh until then.",
        "To fix: make sure the computer or server running the crawler worker is on, awake and connected, and that the worker process is running. Admin → System shows which crawlers are online.",
      ]
    : [
        `A crawler is online again in ${regions}${input.lastCrawler ? ` (${input.lastCrawler.id})` : ""} and is working through the queued SEO scans.`,
        `Scans had been waiting since ${when(input.since)}.`,
      ];
  const body = `
  <div style="display:inline-block;background:${offline ? "#fef3c7" : "#d1fae5"};color:${offline ? C.warning : C.good};font-size:12px;font-weight:700;padding:4px 10px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em;">${offline ? "Action needed" : "Resolved"}</div>
  <h2 style="font-size:18px;margin:14px 0 10px;color:${C.brand};">${escapeHtml(title)}</h2>
  ${lines.map((l) => `<p style="font-size:14px;line-height:1.6;margin:0 0 10px;">${escapeHtml(l)}</p>`).join("")}
  <div style="margin-top:6px;"><a href="${escapeHtml(input.systemUrl)}" style="font-size:14px;color:${C.accent};font-weight:600;">Open Admin → System →</a></div>`;
  const text = [title, "", ...lines, "", `Admin → System: ${input.systemUrl}`].join("\n");
  return { subject: `${offline ? "⚠ " : ""}${title}`, html: layout(title, lines[0].slice(0, 120), body, input.dashboardUrl), text };
}

/** One-time password reset link. No account details beyond the first name, in case the inbox is shared. */
export function renderPasswordResetEmail(input: { name: string; resetUrl: string; expiresAt: Date; dashboardUrl: string; timeZone?: string }) {
  const when = new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone ?? "UTC", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(input.expiresAt);
  const title = "Reset your password";
  const lines = [
    `Hello ${input.name.split(" ")[0]},`,
    "Someone asked to reset the password for your A3 SEO & News Monitor account. Use the button below to choose a new one.",
    `The link works once and expires at ${when}.`,
    "If this wasn't you, ignore this email: your password stays as it is.",
  ];
  const body = `
  <h2 style="font-size:18px;margin:0 0 12px;color:${C.brand};">${escapeHtml(title)}</h2>
  ${lines.map((l) => `<p style="font-size:14px;line-height:1.6;margin:0 0 10px;">${escapeHtml(l)}</p>`).join("")}
  <div style="margin:18px 0 6px;">
    <a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;background:${C.accent};color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 24px;border-radius:8px;">Choose a new password</a>
  </div>
  <p style="font-size:12px;color:${C.muted};line-height:1.6;margin:12px 0 0;">If the button does not work, copy this address into your browser:<br>${escapeHtml(input.resetUrl)}</p>`;
  const text = [title, "", ...lines, "", input.resetUrl].join("\n");
  return { subject: title, html: layout(title, lines[1].slice(0, 120), body, input.dashboardUrl), text };
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
  /** Dealership header colours/logo; omitted = A3 styling. */
  branding?: EmailBranding;
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
  return { subject: `SEO report: ${input.dealershipName}`, html: layout(`SEO report: ${input.dealershipName}`, input.executiveSummary.slice(0, 120), body, input.dashboardUrl, DEFAULT_FOOTER, input.branding), text };
}

/** One line of the month-over-month comparison in the monthly email. */
export interface MonthlyChangeLine {
  title: string;
  priority: string;
  before: number;
  after: number;
}

export interface MonthlyReportEmailInput {
  dealershipName: string;
  websiteUrl: string;
  /** "October 2026". */
  monthLabel: string;
  score: number | null;
  statusLabel: string;
  pagesAnalyzed: number;
  pagesProtected: number;
  /** Open findings by priority, from the report findings. */
  counts: { critical: number; high: number; medium: number; low: number };
  executiveSummary: string;
  actions: Array<{ priority: string; title: string; action: string }>;
  /**
   * Month-over-month change against the latest stored month before this one.
   * null = no earlier month is stored, so there is nothing to compare with.
   */
  comparison: {
    previousMonthLabel: string;
    /** True when the comparison month is not the calendar month just before (a month had no full check). */
    gap: boolean;
    previousScore: number | null;
    scoreDelta: number | null;
    newIssues: MonthlyChangeLine[];
    resolvedIssues: MonthlyChangeLine[];
    improved: MonthlyChangeLine[];
    worsened: MonthlyChangeLine[];
  } | null;
  /** False once the presented scan's individual findings were pruned (totals remain exact). */
  detailsRetained: boolean;
  /** "attached": the PDF is attached. "download": no PDF; sign in to download it. */
  pdf: "attached" | "download";
  /** The signed-in report page (has the PDF download). Never carries a render key. */
  reportUrl: string;
  dashboardUrl: string;
  branding?: EmailBranding;
  /** Admin "send now" test sends say so in the subject. */
  test?: boolean;
}

const MONTHLY_FOOTER =
  "You receive this monthly report because your address is listed as a contact for this dealership in the A3 SEO &amp; News Monitor. The score is calculated by fixed rules from what our website check finds; tracking an issue as fixed or ignored does not change it.";

/**
 * The monthly SEO report: headline facts from the report findings, the grounded
 * recommended actions, and the change since the last stored month. Tables and
 * inline styles only; the KPI tiles wrap to two columns on a phone.
 */
export function renderMonthlyReportEmail(input: MonthlyReportEmailInput) {
  const tone: Record<string, string> = { CRITICAL: C.critical, HIGH: C.warning, MEDIUM: C.accent, LOW: C.muted };
  const title = `Monthly SEO report — ${input.monthLabel}`;
  const cmp = input.comparison;
  const deltaText = cmp?.scoreDelta === null || cmp?.scoreDelta === undefined ? null : `${cmp.scoreDelta > 0 ? "+" : ""}${cmp.scoreDelta}`;
  const tile = (label: string, value: string, sub: string, color = C.text) =>
    `<td class="tile" width="33%" style="padding:6px;vertical-align:top;"><div style="border:1px solid ${C.border};border-radius:8px;padding:10px 12px;">
      <div style="font-size:11px;color:${C.muted};text-transform:uppercase;letter-spacing:.04em;">${escapeHtml(label)}</div>
      <div style="font-size:22px;font-weight:700;color:${color};margin-top:2px;">${escapeHtml(value)}</div>
      <div style="font-size:12px;color:${C.muted};">${escapeHtml(sub)}</div></div></td>`;
  const tiles = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 14px;"><tr>
    ${tile("SEO score", input.score === null ? "—" : `${input.score}/100`, input.score === null ? "Not scored" : input.statusLabel, scoreColor(input.score))}
    ${tile("Since last month", deltaText ?? "—", cmp ? `vs ${cmp.previousMonthLabel}` : "No earlier month stored", cmp?.scoreDelta ? (cmp.scoreDelta > 0 ? C.good : C.critical) : C.text)}
    ${tile("Pages analyzed", String(input.pagesAnalyzed), input.pagesProtected ? `${input.pagesProtected} could not be checked` : "all reachable")}
  </tr></table>`;
  const countsLine = `<p style="font-size:14px;line-height:1.6;margin:0 0 14px;">Open findings: <strong style="color:${C.critical};">${input.counts.critical} critical</strong> · <strong style="color:${C.warning};">${input.counts.high} high</strong> · ${input.counts.medium} medium · ${input.counts.low} low.</p>`;
  // Counts without findings behind them must say so (the same rule as the digest).
  const pruned = !input.detailsRetained
    ? `<p style="font-size:13px;color:${C.muted};line-height:1.5;margin:0 0 14px;">Detailed records for this check are no longer retained. The totals remain accurate, but individual findings cannot be listed.</p>`
    : "";
  const actions = input.actions.slice(0, 5);
  const actionsHtml = actions.length
    ? `<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${C.muted};margin:18px 0 6px;">What to do next</div>
  ${actions.map((a) => `<div style="font-size:14px;line-height:1.5;margin-bottom:10px;"><span style="font-size:11px;font-weight:700;color:${tone[a.priority] ?? C.muted};">${escapeHtml(priorityWord(a.priority))}</span> <strong>${escapeHtml(a.title)}</strong><br>${escapeHtml(a.action)}</div>`).join("")}`
    : "";
  const changeRows = (heading: string, items: MonthlyChangeLine[], colour: string, fmt: (i: MonthlyChangeLine) => string) =>
    items.length
      ? `<tr><td colspan="2" style="padding:10px 0 4px;font-size:13px;font-weight:700;color:${colour};">${escapeHtml(heading)} (${items.length})</td></tr>${items
          .slice(0, 6)
          .map((i) => `<tr><td style="padding:3px 8px 3px 0;font-size:13px;border-top:1px solid ${C.border};">${escapeHtml(i.title)}</td><td align="right" style="padding:3px 0;font-size:12px;color:${C.muted};white-space:nowrap;border-top:1px solid ${C.border};">${escapeHtml(fmt(i))}</td></tr>`)
          .join("")}${items.length > 6 ? `<tr><td colspan="2" style="font-size:12px;color:${C.muted};padding:2px 0;">and ${items.length - 6} more in the dashboard</td></tr>` : ""}`
      : "";
  const pages = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;
  const comparisonHtml = !cmp
    ? `<p style="font-size:13px;color:${C.muted};line-height:1.5;margin:18px 0 0;">This is the first month with a stored full check of this website, so there is no month-over-month comparison yet. Next month's report will show what changed.</p>`
    : (() => {
        const rows =
          changeRows("New this month", cmp.newIssues, C.critical, (i) => pages(i.after)) +
          changeRows("Fixed since last month", cmp.resolvedIssues, C.good, (i) => `was ${pages(i.before)}`) +
          changeRows("Improved", cmp.improved, C.good, (i) => `${i.before} → ${i.after}`) +
          changeRows("Got worse", cmp.worsened, C.warning, (i) => `${i.before} → ${i.after}`);
        return `<div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:${C.muted};margin:20px 0 4px;">Compared with ${escapeHtml(cmp.previousMonthLabel)}</div>
  ${cmp.gap ? `<p style="font-size:12px;color:${C.muted};margin:0 0 4px;">No full check of the website was stored for the month in between, so this compares with the latest month that has one.</p>` : ""}
  ${rows ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows}</table>` : `<p style="font-size:13px;line-height:1.5;margin:4px 0 0;">The same issues were found as in ${escapeHtml(cmp.previousMonthLabel)}, on the same number of pages.</p>`}`;
      })();
  const pdfHtml =
    input.pdf === "attached"
      ? `<p style="font-size:13px;line-height:1.5;margin:18px 0 0;">The full report is attached as a PDF.</p>`
      : `<p style="font-size:13px;line-height:1.5;margin:18px 0 0;">The PDF version could not be attached this time. <a href="${escapeHtml(input.reportUrl)}" style="color:${C.accent};font-weight:600;">Sign in to view the report and download the PDF →</a></p>`;
  const protectedNote = input.pagesProtected
    ? `<p style="font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:8px 10px;line-height:1.5;margin:0 0 14px;">${input.pagesProtected} page(s) could not be checked because the website restricted automated access. These are <strong>not</strong> SEO problems.</p>`
    : "";
  const body = `
  <h2 style="font-size:18px;margin:0 0 4px;color:${C.brand};">${escapeHtml(input.dealershipName)}</h2>
  <div style="font-size:13px;color:${C.muted};margin-bottom:12px;"><a href="${escapeHtml(input.websiteUrl)}" style="color:${C.muted};">${escapeHtml(input.websiteUrl)}</a></div>
  ${tiles}${protectedNote}${countsLine}${pruned}
  <p style="font-size:14px;line-height:1.6;margin:0;">${escapeHtml(input.executiveSummary)}</p>
  ${actionsHtml}${comparisonHtml}${pdfHtml}`;

  const lineText = (heading: string, items: MonthlyChangeLine[], fmt: (i: MonthlyChangeLine) => string) => (items.length ? [`${heading}:`, ...items.slice(0, 6).map((i) => `- ${i.title} (${fmt(i)})`), ...(items.length > 6 ? [`  and ${items.length - 6} more`] : [])] : []);
  const text = [
    title,
    `${input.dealershipName} — ${input.websiteUrl}`,
    "",
    `SEO score: ${input.score === null ? "not scored" : `${input.score}/100`}${deltaText && cmp ? ` (${deltaText} since ${cmp.previousMonthLabel})` : ""} · ${input.statusLabel} · ${input.pagesAnalyzed} pages analyzed${input.pagesProtected ? ` · ${input.pagesProtected} could not be checked (not SEO problems)` : ""}`,
    `Open findings: ${input.counts.critical} critical · ${input.counts.high} high · ${input.counts.medium} medium · ${input.counts.low} low`,
    ...(!input.detailsRetained ? ["Detailed records for this check are no longer retained. The totals remain accurate, but individual findings cannot be listed."] : []),
    "",
    input.executiveSummary,
    "",
    ...(actions.length ? ["What to do next:", ...actions.map((a, n) => `${n + 1}. [${priorityWord(a.priority)}] ${a.title}: ${a.action}`), ""] : []),
    ...(cmp
      ? [
          `Compared with ${cmp.previousMonthLabel}:`,
          ...lineText("New this month", cmp.newIssues, (i) => pages(i.after)),
          ...lineText("Fixed since last month", cmp.resolvedIssues, (i) => `was ${pages(i.before)}`),
          ...lineText("Improved", cmp.improved, (i) => `${i.before} -> ${i.after}`),
          ...lineText("Got worse", cmp.worsened, (i) => `${i.before} -> ${i.after}`),
          "",
        ]
      : ["No earlier month is stored yet, so there is no month-over-month comparison.", ""]),
    input.pdf === "attached" ? "The full report is attached as a PDF." : `The PDF could not be attached this time. Sign in to view and download it: ${input.reportUrl}`,
    `Dashboard: ${input.dashboardUrl}`,
  ].join("\n");
  const subject = `${input.test ? "[Test] " : ""}${title}: ${input.dealershipName}${input.score !== null ? ` · ${input.score}/100` : ""}${deltaText && cmp ? ` (${deltaText})` : ""}`;
  return { subject, html: layout(title, `${input.dealershipName}: ${input.executiveSummary}`.slice(0, 140), body, input.dashboardUrl, MONTHLY_FOOTER, input.branding, "Open dashboard"), text };
}
