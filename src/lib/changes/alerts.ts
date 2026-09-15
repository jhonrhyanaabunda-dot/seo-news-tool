import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { alerts, dealerships, type Alert, type Dealership, type ScanChangeSummary } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { getSettings, type AppSettings } from "@/lib/settings";
import { isSignificantScoreChange } from "./detect";

type AlertInput = {
  dealershipId: number;
  scanId?: number | null;
  type: Alert["type"];
  severity: Alert["severity"];
  title: string;
  message: string;
  payload?: Record<string, unknown>;
  dedupeKey: string;
};

/**
 * Record an alert exactly once (dedupe key is unique). Critical alerts are
 * emailed immediately when instant alerts are enabled globally and for the
 * dealership; everything else is summarised in the next digest.
 */
export async function createAlert(input: AlertInput, opts?: { settings?: AppSettings; dealership?: Dealership }): Promise<Alert | null> {
  const [alert] = await db
    .insert(alerts)
    .values({
      dealershipId: input.dealershipId,
      scanId: input.scanId ?? null,
      type: input.type,
      severity: input.severity,
      title: input.title.slice(0, 300),
      message: input.message,
      payload: input.payload,
      dedupeKey: input.dedupeKey.slice(0, 200),
    })
    .onConflictDoNothing()
    .returning();
  if (!alert) return null;

  if (alert.severity === "critical") {
    const s = opts?.settings ?? (await getSettings());
    const dealer = opts?.dealership ?? (await db.select().from(dealerships).where(eq(dealerships.id, input.dealershipId)).limit(1))[0];
    if (s.instantAlertsEnabled && dealer?.instantAlertsEnabled) {
      await enqueueJob({ type: "alert", dealershipId: alert.dealershipId, payload: { alertId: alert.id }, dedupeKey: `alert:${alert.id}`, priority: 10 });
    }
  }
  await logger.info("alerts", `Alert created: ${alert.title}`, { type: alert.type, alertId: alert.id }, alert.dealershipId);
  return alert;
}

/** Decide which alerts a finished scan warrants. */
export async function createScanAlerts(params: {
  dealership: Dealership;
  scanId: number;
  score: number | null;
  siteAvailable: boolean;
  previousSiteAvailable: boolean | null;
  hasBaseline: boolean;
  change: ScanChangeSummary;
  settings: AppSettings;
}) {
  const { dealership: d, scanId, change, settings: s } = params;
  const opts = { settings: s, dealership: d };
  const created: Alert[] = [];
  const push = (a: Alert | null) => a && created.push(a);

  if (!params.siteAvailable && params.previousSiteAvailable !== false) {
    push(
      await createAlert(
        {
          dealershipId: d.id,
          scanId,
          type: "site_unavailable",
          severity: "critical",
          title: `${d.name}: website unavailable`,
          message: `The website ${d.websiteUrl} could not be loaded during the latest scan. Visitors and search engines may be unable to reach it.`,
          dedupeKey: `site_unavailable:${d.id}:${scanId}`,
        },
        opts,
      ),
    );
  }
  if (params.siteAvailable && params.previousSiteAvailable === false) {
    push(
      await createAlert(
        {
          dealershipId: d.id,
          scanId,
          type: "site_recovered",
          severity: "info",
          title: `${d.name}: website is back online`,
          message: `The website ${d.websiteUrl} is responding normally again.`,
          dedupeKey: `site_recovered:${d.id}:${scanId}`,
        },
        opts,
      ),
    );
  }
  if (!params.hasBaseline) return created; // first scan establishes the baseline — nothing is "new" yet

  if (change.newCriticalCount > 0) {
    const top = change.newIssues.filter((i) => i.severity === "critical").slice(0, 10);
    push(
      await createAlert(
        {
          dealershipId: d.id,
          scanId,
          type: "new_critical_issues",
          severity: "critical",
          title: `${d.name}: ${change.newCriticalCount} new critical SEO issue${change.newCriticalCount === 1 ? "" : "s"}`,
          message: top.map((i) => `• ${i.message} (${i.url})`).join("\n"),
          payload: { issues: top },
          dedupeKey: `new_critical:${d.id}:${scanId}`,
        },
        opts,
      ),
    );
  }
  if (isSignificantScoreChange(change.scoreDelta, s.scoreChangeThreshold) && change.scoreDelta !== null) {
    const drop = change.scoreDelta < 0;
    push(
      await createAlert(
        {
          dealershipId: d.id,
          scanId,
          type: drop ? "score_drop" : "score_gain",
          severity: drop ? "warning" : "info",
          title: `${d.name}: SEO score ${drop ? "dropped" : "improved"} ${Math.abs(change.scoreDelta)} points`,
          message: `SEO score changed from ${change.previousScore} to ${params.score}.`,
          payload: { from: change.previousScore, to: params.score },
          dedupeKey: `score:${d.id}:${scanId}`,
        },
        opts,
      ),
    );
  }
  if (change.resolvedCount > 0) {
    push(
      await createAlert(
        {
          dealershipId: d.id,
          scanId,
          type: "issues_resolved",
          severity: "info",
          title: `${d.name}: ${change.resolvedCount} SEO issue${change.resolvedCount === 1 ? "" : "s"} resolved`,
          message: change.resolvedIssues
            .slice(0, 10)
            .map((i) => `• ${i.message} (${i.url})`)
            .join("\n"),
          dedupeKey: `resolved:${d.id}:${scanId}`,
        },
        opts,
      ),
    );
  }
  return created;
}
