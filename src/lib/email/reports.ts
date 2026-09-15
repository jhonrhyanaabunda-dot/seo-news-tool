import "server-only";
import { and, desc, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alerts, dealerships, newsArticles, seoIssues, seoScans, type Dealership } from "@/lib/db/schema";
import { diffFingerprints } from "@/lib/changes/detect";
import { env } from "@/lib/env";
import { CHECKS_BY_KEY } from "@/lib/seo/checks/config";
import { getSettings, type AppSettings } from "@/lib/settings";
import { sendTrackedEmail } from "./send";
import { sameWebsite } from "@/lib/seo/site-identity";
import { renderAlertEmail, renderDigestEmail, type DigestDealer } from "./templates";
import { OUTCOME_META } from "@/lib/seo/outcome";
import { getTopSeoStories } from "@/lib/news/seo-industry";

const dashboardUrl = () => env().APP_URL.replace(/\/$/, "");
const reportUrl = (id: number) => `${dashboardUrl()}/dealerships/${id}`;

/** Build the digest section for one dealership over [periodStart, now]. */
export async function buildDealerDigest(d: Dealership, periodStart: Date, s: AppSettings): Promise<DigestDealer> {
  const [latest] = await db
    .select()
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, d.id), eq(seoScans.status, "completed")))
    .orderBy(desc(seoScans.completedAt))
    .limit(1);
  const candidates = await db
    .select()
    .from(seoScans)
    .where(
      and(
        eq(seoScans.dealershipId, d.id),
        eq(seoScans.status, "completed"),
        eq(seoScans.siteAvailable, true),
        isNotNull(seoScans.issueFingerprints),
        lt(seoScans.completedAt, periodStart),
      ),
    )
    .orderBy(desc(seoScans.completedAt))
    .limit(20);
  // A scan of a previous website address is not a valid baseline.
  // Blocked / partially blocked scans didn't evaluate every page, so they are not valid baselines.
  const baseline = latest ? candidates.find((c) => sameWebsite(c, latest) && c.outcome !== "blocked" && c.outcome !== "partially_blocked") : undefined;

  let newCritical = 0;
  let newWarnings = 0;
  let resolved = 0;
  let scoreDelta: number | null = null;
  const latestInPeriod = latest?.completedAt && latest.completedAt >= periodStart;
  if (latest && baseline && latestInPeriod && latest.siteAvailable && latest.issueFingerprints) {
    const diff = diffFingerprints(baseline.issueFingerprints, latest.issueFingerprints);
    newCritical = diff.addedBySeverity.c;
    newWarnings = diff.addedBySeverity.w;
    resolved = diff.resolved.length;
    if (latest.score !== null && baseline.score !== null) scoreDelta = latest.score - baseline.score;
  }

  const topIssues = latest
    ? await db
        .select({ checkKey: seoIssues.checkKey, severity: seoIssues.severity, count: sql<number>`count(*)::int` })
        .from(seoIssues)
        .where(and(eq(seoIssues.scanId, latest.id), inArray(seoIssues.severity, ["critical", "warning"])))
        .groupBy(seoIssues.checkKey, seoIssues.severity)
        .orderBy(sql`case when ${seoIssues.severity} = 'critical' then 0 else 1 end`, desc(sql`count(*)`))
        .limit(3)
    : [];

  const news = await db
    .select({ id: newsArticles.id, title: newsArticles.title, url: newsArticles.url, source: newsArticles.source })
    .from(newsArticles)
    .where(
      and(
        eq(newsArticles.dealershipId, d.id),
        eq(newsArticles.scope, "dealership"),
        gte(newsArticles.detectedAt, periodStart),
        ne(newsArticles.relevance, "not_relevant"),
        or(gte(newsArticles.relevanceScore, s.newsAlertMinScore), eq(newsArticles.relevance, "relevant")),
      ),
    )
    .orderBy(desc(newsArticles.relevanceScore), desc(newsArticles.detectedAt))
    .limit(50);

  const periodAlerts = await db
    .select({ title: alerts.title, type: alerts.type })
    .from(alerts)
    .where(and(eq(alerts.dealershipId, d.id), gte(alerts.createdAt, periodStart), ne(alerts.type, "new_relevant_news")))
    .orderBy(desc(alerts.createdAt))
    .limit(6);

  const siteAvailable = latest?.siteAvailable ?? null;
  const hasChanges =
    newCritical + newWarnings + resolved > 0 ||
    (scoreDelta !== null && Math.abs(scoreDelta) >= s.scoreChangeThreshold) ||
    news.length > 0 ||
    periodAlerts.length > 0 ||
    siteAvailable === false;

  return {
    id: d.id,
    name: d.name,
    brand: d.brand,
    score: latest?.score ?? null,
    scoreDelta,
    critical: latest?.criticalCount ?? 0,
    warnings: latest?.warningCount ?? 0,
    newCritical,
    newWarnings,
    resolved,
    newNews: news.length,
    newsHeadlines: news.slice(0, 3),
    topIssues: topIssues.map((t) => ({ label: CHECKS_BY_KEY[t.checkKey]?.problem ?? t.checkKey, count: t.count, severity: t.severity })),
    changes: periodAlerts.map((a) => a.title.replace(`${d.name}: `, "")),
    siteAvailable,
    scanStatus: latest?.outcome ? OUTCOME_META[latest.outcome].label : null,
    notEvaluated: (latest?.pagesBlocked ?? 0) + (latest?.pagesNotEvaluated ?? 0),
    limitedCheck: latest?.siteChecks?.auditMode === "remote",
    lastScanAt: latest?.completedAt ?? null,
    reportUrl: reportUrl(d.id),
    hasChanges,
  };
}

function digestPeriodLabel(kind: "daily" | "weekly", periodStart: Date, periodEnd: Date): string {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: env().APP_TIMEZONE, dateStyle: "medium" });
  return kind === "daily" ? `Changes in the last 24 hours · ${fmt.format(periodEnd)}` : `Week of ${fmt.format(periodStart)} to ${fmt.format(periodEnd)}`;
}

const bySignificance = (a: DigestDealer, b: DigestDealer) => Number(b.hasChanges) - Number(a.hasChanges) || b.newCritical - a.newCritical || a.name.localeCompare(b.name);

/**
 * Send the daily digest or the weekly newsletter. One email per recipient
 * containing every dealership they follow. Daily recipients with nothing
 * meaningful to report are skipped (unless "send when no changes" is enabled);
 * the weekly newsletter always goes out while there is SEO industry news to share.
 */
export async function sendDigests(kind: "daily" | "weekly", periodKey: string): Promise<{ recipients: number; sent: number; skipped: number; failed: number }> {
  const s = await getSettings();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - (kind === "daily" ? 1 : 7) * 86_400_000);
  const dealers = await db.select().from(dealerships).where(eq(dealerships.isActive, true)).orderBy(dealerships.name);

  const byRecipient = new Map<string, Dealership[]>();
  for (const d of dealers) {
    const list = new Set([...(d.notificationEmails ?? []), ...s.managementRecipients].map((e) => e.toLowerCase()));
    for (const email of list) byRecipient.set(email, [...(byRecipient.get(email) ?? []), d]);
  }
  // The newsletter reaches management and newsletter-only recipients with the whole portfolio, even when no dealership exists yet.
  if (kind === "weekly") for (const email of [...s.managementRecipients, ...s.newsletterRecipients]) byRecipient.set(email.toLowerCase(), dealers);
  const seoStories = kind === "weekly" ? await getTopSeoStories(periodStart) : [];

  const cache = new Map<number, DigestDealer>();
  const digestFor = async (d: Dealership) => {
    if (!cache.has(d.id)) cache.set(d.id, await buildDealerDigest(d, periodStart, s));
    return cache.get(d.id)!;
  };

  const periodLabel = digestPeriodLabel(kind, periodStart, periodEnd);
  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const [email, list] of byRecipient) {
    const sections = await Promise.all(list.map(digestFor));
    if (!sections.some((x) => x.hasChanges) && !s.sendDigestWhenNoChanges && !seoStories.length) {
      skipped++;
      continue;
    }
    sections.sort(bySignificance);
    const { subject, html, text } = renderDigestEmail({ kind, periodLabel, dealers: sections, dashboardUrl: dashboardUrl(), seoStories, timeZone: env().APP_TIMEZONE });
    const result = await sendTrackedEmail({
      dedupeKey: `digest:${kind}:${periodKey}:${email}`,
      kind: kind === "daily" ? "daily_digest" : "weekly_digest",
      to: email,
      subject,
      html,
      text,
      payload: { dealershipIds: list.map((d) => d.id) },
      periodStart,
      periodEnd,
    });
    if (result === "sent") sent++;
    else if (result === "skipped") skipped++;
    else failed++;
  }

  await db
    .update(alerts)
    .set({ includedInDigestAt: new Date() })
    .where(and(gte(alerts.createdAt, periodStart), sql`${alerts.includedInDigestAt} is null`));

  if (failed > 0) throw new Error(`${failed} digest email(s) failed to send; they will be retried.`);
  return { recipients: byRecipient.size, sent, skipped, failed };
}

/**
 * Send this week's newsletter (whole portfolio) to one address right now, so an
 * admin can review it. Does not affect the scheduled send or mark alerts as included.
 */
export async function sendNewsletterPreview(to: string, requestedBy: number): Promise<"sent" | "skipped" | "failed"> {
  const s = await getSettings();
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - 7 * 86_400_000);
  const dealers = await db.select().from(dealerships).where(eq(dealerships.isActive, true)).orderBy(dealerships.name);
  const [sections, seoStories] = await Promise.all([Promise.all(dealers.map((d) => buildDealerDigest(d, periodStart, s))), getTopSeoStories(periodStart)]);
  sections.sort(bySignificance);
  const email = renderDigestEmail({ kind: "weekly", periodLabel: digestPeriodLabel("weekly", periodStart, periodEnd), dealers: sections, dashboardUrl: dashboardUrl(), seoStories, timeZone: env().APP_TIMEZONE });
  return sendTrackedEmail({
    dedupeKey: `newsletter-preview:${requestedBy}:${Date.now()}`,
    kind: "test",
    to,
    subject: `[Preview] ${email.subject}`,
    html: email.html,
    text: email.text,
  });
}

/** Immediate email for a critical alert. Idempotent per alert and recipient. */
export async function sendAlertEmail(alertId: number): Promise<{ sent: number; failed: number }> {
  const [alert] = await db.select().from(alerts).where(eq(alerts.id, alertId)).limit(1);
  if (!alert) return { sent: 0, failed: 0 };
  const [d] = await db.select().from(dealerships).where(eq(dealerships.id, alert.dealershipId)).limit(1);
  if (!d) return { sent: 0, failed: 0 };
  const s = await getSettings();
  const recipients = [...new Set([...(d.notificationEmails ?? []), ...s.managementRecipients].map((e) => e.toLowerCase()))];
  const { subject, html, text } = renderAlertEmail({
    title: alert.title,
    message: alert.message,
    dealershipName: d.name,
    websiteUrl: d.websiteUrl,
    reportUrl: reportUrl(d.id),
    dashboardUrl: dashboardUrl(),
    detectedAt: alert.createdAt,
    timeZone: env().APP_TIMEZONE,
  });
  let sent = 0;
  let failed = 0;
  for (const to of recipients) {
    const r = await sendTrackedEmail({ dedupeKey: `alert:${alert.id}:${to}`, kind: "alert", dealershipId: d.id, to, subject, html, text, payload: { alertId: alert.id } });
    if (r === "failed") failed++;
    else sent++;
  }
  if (failed === 0) await db.update(alerts).set({ notifiedAt: new Date() }).where(eq(alerts.id, alert.id));
  if (failed > 0) throw new Error(`${failed} alert email(s) failed to send; they will be retried.`);
  return { sent, failed };
}
