import "server-only";
import { and, eq, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { competitorSnapshots, competitors, dealershipIntegrations, dealerships, gscDaily, gscTopItems, placeSnapshots, type CompetitorMetrics, type CompetitorSnapshotStatus, type IntegrationKind, type Job } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { logger, errorMessage } from "@/lib/logger";
import { enqueueJob } from "@/lib/jobs/queue";
import { safeFetch } from "@/lib/seo/fetcher";
import { loadRobots } from "@/lib/seo/robots";
import { detectBlock } from "@/lib/seo/block-detect";
import { parsePage } from "@/lib/seo/parser";
import { friendlyFetchError } from "@/lib/seo/messages";
import { pageSpeedEnabled, runPageSpeed } from "@/lib/seo/pagespeed";
import { GoogleApiError, GoogleTokenCache } from "./google-auth";
import { createGscClient, createPlacesClient } from "./clients";
import { gscConfigured, placesConfigured, serviceAccount } from "./config";
import { GSC_PERIOD_DAYS, GSC_TOP_ROWS, addDays, pacificDate, searchAnalyticsRequest, syncWindow } from "./gsc";
import { matchCandidateByHost, placeSearchQuery } from "./places";
import { emptyMetrics, metricsFromPage } from "./competitor-metrics";

/**
 * Background sync for the data integrations. Each job handles one dealership
 * (or one competitor) and makes its API requests one after another, which
 * keeps Search Console and Places usage far below their per-minute quotas.
 *
 * Failures are stored readably on `dealership_integrations` (or the competitor
 * snapshot). Permanent ones — no access, wrong property, refused key — finish
 * the job without retrying; transient ones (network, 429, 5xx) are rethrown so
 * the queue retries with backoff.
 */

/** One per process: access tokens are reused until shortly before they expire. */
const tokens = new GoogleTokenCache();
const PLACE_SNAPSHOT_RETENTION_DAYS = 730;
const COMPETITOR_SNAPSHOT_RETENTION_DAYS = 400;
/**
 * A competitor audit may wait on PageSpeed for up to a minute; don't start one the tick budget would cut off.
 * Without PageSpeed, robots.txt + one homepage request fit in 40 s (so the post-request kick can run it).
 */
const COMPETITOR_MIN_BUDGET_MS = 100_000;

export function gscClient() {
  const account = serviceAccount();
  return account ? createGscClient({ account, tokens }) : null;
}

export function placesClient() {
  const key = env().GOOGLE_PLACES_API_KEY?.trim();
  return key ? createPlacesClient({ apiKey: key }) : null;
}

async function recordStatus(dealershipId: number, kind: IntegrationKind, patch: Partial<typeof dealershipIntegrations.$inferInsert>) {
  const now = new Date();
  await db
    .insert(dealershipIntegrations)
    .values({ dealershipId, kind, lastAttemptAt: now, updatedAt: now, ...patch })
    .onConflictDoUpdate({ target: [dealershipIntegrations.dealershipId, dealershipIntegrations.kind], set: { lastAttemptAt: now, updatedAt: now, ...patch } });
}

/* ─────────────────────────── Search Console ─────────────────────────── */

export async function runGscSync(dealershipId: number, now = new Date()): Promise<Record<string, unknown>> {
  const [d] = await db.select({ id: dealerships.id, property: dealerships.gscProperty }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d?.property) return { skipped: "no Search Console property" };
  const client = gscClient();
  if (!client) return { skipped: "Search Console is not configured" };
  const property = d.property;

  // A different property is a different data set; never mix the two.
  await db.delete(gscDaily).where(and(eq(gscDaily.dealershipId, d.id), ne(gscDaily.property, property)));
  const [{ latest }] = await db.select({ latest: sql<string | null>`max(${gscDaily.date})::text` }).from(gscDaily).where(eq(gscDaily.dealershipId, d.id));

  const window = syncWindow(pacificDate(now), latest);
  const daily = await client.query(property, searchAnalyticsRequest(window.startDate, window.endDate, "date", 1000));
  const rows = daily.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.key));
  for (let i = 0; i < rows.length; i += 200) {
    await db
      .insert(gscDaily)
      .values(rows.slice(i, i + 200).map((r) => ({ dealershipId: d.id, property, date: r.key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })))
      .onConflictDoUpdate({
        target: [gscDaily.dealershipId, gscDaily.date],
        set: { property, clicks: sql`excluded.clicks`, impressions: sql`excluded.impressions`, ctr: sql`excluded.ctr`, position: sql`excluded.position` },
      });
  }
  const newest = rows.reduce<string | null>((m, r) => (m === null || r.key > m ? r.key : m), latest);

  let topQueries = 0;
  let topPages = 0;
  if (newest) {
    // Top lists cover the same 28 days as the headline totals.
    const periodStart = addDays(newest, -(GSC_PERIOD_DAYS - 1));
    const queries = await client.query(property, searchAnalyticsRequest(periodStart, newest, "query", GSC_TOP_ROWS));
    const pages = await client.query(property, searchAnalyticsRequest(periodStart, newest, "page", GSC_TOP_ROWS));
    topQueries = queries.length;
    topPages = pages.length;
    const items = [
      ...queries.map((r) => ({ kind: "query" as const, ...r })),
      ...pages.map((r) => ({ kind: "page" as const, ...r })),
    ].map((r) => ({ dealershipId: d.id, kind: r.kind, periodStart, periodEnd: newest, key: r.key, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position }));
    await db.transaction(async (tx) => {
      await tx.delete(gscTopItems).where(eq(gscTopItems.dealershipId, d.id));
      if (items.length) await tx.insert(gscTopItems).values(items);
    });
  }

  await recordStatus(d.id, "gsc", { status: "ok", configKey: property, lastSyncedAt: new Date(), lastError: null, dataThrough: newest });
  return { property, initial: window.initial, days: rows.length, dataThrough: newest, topQueries, topPages };
}

/* ─────────────────────────── Google listing ─────────────────────────── */

export async function runPlacesSync(dealershipId: number): Promise<Record<string, unknown>> {
  const [d] = await db.select({ id: dealerships.id, placeId: dealerships.googlePlaceId }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d?.placeId) return { skipped: "no Google place id" };
  const client = placesClient();
  if (!client) return { skipped: "Places API is not configured" };

  const details = await client.details(d.placeId);
  await db.insert(placeSnapshots).values({ dealershipId: d.id, rating: details.rating, reviewCount: details.reviewCount, businessStatus: details.businessStatus, data: details.data });
  // Google occasionally replaces a place id (listings merged or moved); follow it so the next sync keeps working.
  const currentId = details.data.placeId;
  if (currentId !== d.placeId) await db.update(dealerships).set({ googlePlaceId: currentId }).where(eq(dealerships.id, d.id));
  await db.delete(placeSnapshots).where(and(eq(placeSnapshots.dealershipId, d.id), lt(placeSnapshots.capturedAt, new Date(Date.now() - PLACE_SNAPSHOT_RETENTION_DAYS * 86_400_000))));
  await recordStatus(d.id, "places", { status: "ok", configKey: currentId, lastSyncedAt: new Date(), lastError: null });
  return { rating: details.rating, reviewCount: details.reviewCount, businessStatus: details.businessStatus };
}

/* ─────────────────────────── Competitors ─────────────────────────── */

/**
 * One homepage request per competitor per week with the monitor's honest
 * User-Agent. robots.txt is honoured and bot protection is never bypassed:
 * either one means the competitor is recorded as "blocked".
 */
export async function runCompetitorAudit(competitorId: number): Promise<Record<string, unknown>> {
  const [c] = await db
    .select({ id: competitors.id, name: competitors.name, websiteUrl: competitors.websiteUrl, host: competitors.host, placeId: competitors.googlePlaceId, city: dealerships.city, state: dealerships.state })
    .from(competitors)
    .innerJoin(dealerships, eq(dealerships.id, competitors.dealershipId))
    .where(eq(competitors.id, competitorId))
    .limit(1);
  if (!c) return { skipped: "competitor removed" };

  let metrics: CompetitorMetrics = emptyMetrics();
  let status: CompetitorSnapshotStatus = "ok";
  let error: string | null = null;

  const robots = await loadRobots(c.websiteUrl, { renderMode: "never" });
  if (robots.blocked) {
    status = "blocked";
    error = "The website's security refused the monitor's request for robots.txt, so the homepage was not requested.";
  } else if (robots.blocksMonitor) {
    status = "blocked";
    error = "The website's robots.txt does not allow the A3SEOMonitor crawler, so the homepage was not requested.";
  } else {
    const res = await safeFetch(c.websiteUrl, { htmlOnly: true, retries: 1 });
    const block = detectBlock(res);
    if (block.blocked) {
      status = "blocked";
      error = block.reason ?? "The website refused the monitor's request.";
      metrics.httpStatus = res.status;
    } else if (!res.ok || !res.body) {
      status = "error";
      error = friendlyFetchError(res.errorCode, res.status);
      metrics.httpStatus = res.status;
    } else {
      metrics = metricsFromPage(parsePage(res.body, res.finalUrl), res);
    }
  }

  // Listing signals and PageSpeed are extras: their failure never fails the audit.
  const places = placesClient();
  if (places) {
    try {
      let placeId = c.placeId;
      if (!placeId) {
        const match = matchCandidateByHost(await places.search(placeSearchQuery(c)), c.host);
        if (match) {
          placeId = match.id;
          await db.update(competitors).set({ googlePlaceId: placeId }).where(eq(competitors.id, c.id));
        }
      }
      if (placeId) {
        const details = await places.details(placeId);
        metrics.rating = details.rating;
        metrics.reviewCount = details.reviewCount;
      }
    } catch (err) {
      await logger.warn("integrations", "Competitor Google listing lookup failed", { competitorId: c.id, error: errorMessage(err) });
    }
  }
  if (status === "ok" && pageSpeedEnabled() && metrics.finalUrl) {
    const ps = await runPageSpeed(metrics.finalUrl, "mobile");
    if (!ps.error) metrics.performance = ps.performance;
  }

  await db.insert(competitorSnapshots).values({ competitorId: c.id, status, error, metrics });
  await db.delete(competitorSnapshots).where(and(eq(competitorSnapshots.competitorId, c.id), lt(competitorSnapshots.capturedAt, new Date(Date.now() - COMPETITOR_SNAPSHOT_RETENTION_DAYS * 86_400_000))));
  return { competitorId: c.id, status };
}

/* ─────────────────────────── Job entry point ─────────────────────────── */

export type IntegrationJobOutcome = { done: true; result: Record<string, unknown> } | { done: false; delayMs: number };

/** Called by the job runner for gsc_sync, places_sync and competitor_audit jobs. */
export async function runIntegrationJob(job: Job, deadline: number): Promise<IntegrationJobOutcome> {
  if (job.type === "competitor_audit") {
    if (deadline - Date.now() < (pageSpeedEnabled() ? COMPETITOR_MIN_BUDGET_MS : COMPETITOR_MIN_BUDGET_MS / 2.5)) return { done: false, delayMs: 0 };
    return { done: true, result: await runCompetitorAudit(Number(job.payload.competitorId)) };
  }
  const kind: IntegrationKind = job.type === "gsc_sync" ? "gsc" : "places";
  const dealershipId = Number(job.dealershipId);
  try {
    const result = kind === "gsc" ? await runGscSync(dealershipId) : await runPlacesSync(dealershipId);
    return { done: true, result };
  } catch (err) {
    const message = errorMessage(err).slice(0, 2000);
    const [d] = await db.select({ gsc: dealerships.gscProperty, place: dealerships.googlePlaceId }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
    const permanent = err instanceof GoogleApiError && err.permanent;
    await recordStatus(dealershipId, kind, {
      status: "error",
      configKey: (kind === "gsc" ? d?.gsc : d?.place) ?? null,
      lastError: permanent || job.attempts + 1 >= job.maxAttempts ? message : `${message} (will retry automatically)`,
    });
    if (permanent) {
      await logger.warn("integrations", `${kind === "gsc" ? "Search Console" : "Google listing"} sync failed`, { error: message }, dealershipId);
      return { done: true, result: { error: message } };
    }
    throw err;
  }
}

/* ─────────────────────────── Scheduling ─────────────────────────── */

const GSC_INTERVAL_HOURS = 23;
const WEEKLY_INTERVAL_HOURS = 7 * 24 - 1;
const MAX_PER_TICK = 50;
/** Low priority: these never compete with scans, news or emails. */
export const INTEGRATION_PRIORITY = { gsc_sync: 150, places_sync: 160, competitor_audit: 170 } as const;

async function enqueue(type: "gsc_sync" | "places_sync" | "competitor_audit", dealershipId: number, payload: Record<string, unknown>, dedupeKey: string, priority: number) {
  return enqueueJob({ type, dealershipId, payload, dedupeKey, priority, maxAttempts: 4 });
}

/**
 * Due integration work: Search Console daily, Google listing weekly, each
 * competitor weekly — and right away when a property or place id changes.
 * Marks each item scheduled when queued, so a failing API cannot cause a retry
 * storm every tick (the queue's own retries handle transient failures).
 */
export async function scheduleIntegrationWork(now = new Date()): Promise<{ gsc: number; places: number; competitors: number }> {
  const out = { gsc: 0, places: 0, competitors: 0 };
  const nowIso = now.toISOString();
  const due = async (kind: IntegrationKind, column: "gsc_property" | "google_place_id", hours: number) =>
    (await db.execute<{ id: number }>(sql`
      select d.id from ${dealerships} d
      left join ${dealershipIntegrations} i on i.dealership_id = d.id and i.kind = ${kind}
      where d.is_active and d.${sql.raw(column)} is not null
        and (i.dealership_id is null or i.config_key is distinct from d.${sql.raw(column)} or i.last_scheduled_at is null
             or i.last_scheduled_at <= ${nowIso}::timestamptz - make_interval(hours => ${hours}::int))
      order by i.last_scheduled_at asc nulls first, d.id asc
      limit ${MAX_PER_TICK}
    `)) as unknown as Array<{ id: number }>;

  const markScheduled = (dealershipId: number, kind: IntegrationKind) =>
    db
      .insert(dealershipIntegrations)
      .values({ dealershipId, kind, status: "pending", lastScheduledAt: now })
      .onConflictDoUpdate({ target: [dealershipIntegrations.dealershipId, dealershipIntegrations.kind], set: { lastScheduledAt: now } });

  if (gscConfigured()) {
    for (const row of await due("gsc", "gsc_property", GSC_INTERVAL_HOURS)) {
      const id = Number(row.id);
      if (await enqueue("gsc_sync", id, {}, `gsc:${id}`, INTEGRATION_PRIORITY.gsc_sync)) out.gsc++;
      await markScheduled(id, "gsc");
    }
  }
  if (placesConfigured()) {
    for (const row of await due("places", "google_place_id", WEEKLY_INTERVAL_HOURS)) {
      const id = Number(row.id);
      if (await enqueue("places_sync", id, {}, `places:${id}`, INTEGRATION_PRIORITY.places_sync)) out.places++;
      await markScheduled(id, "places");
    }
  }
  const dueCompetitors = (await db.execute<{ id: number; dealership_id: number }>(sql`
    select c.id, c.dealership_id from ${competitors} c
    join ${dealerships} d on d.id = c.dealership_id
    where d.is_active
      and (c.last_audit_scheduled_at is null or c.last_audit_scheduled_at <= ${nowIso}::timestamptz - make_interval(hours => ${WEEKLY_INTERVAL_HOURS}::int))
    order by c.last_audit_scheduled_at asc nulls first, c.id asc
    limit ${MAX_PER_TICK}
  `)) as unknown as Array<{ id: number; dealership_id: number }>;
  for (const row of dueCompetitors) {
    const id = Number(row.id);
    if (await enqueue("competitor_audit", Number(row.dealership_id), { competitorId: id }, `competitor:${id}`, INTEGRATION_PRIORITY.competitor_audit)) out.competitors++;
    await db.update(competitors).set({ lastAuditScheduledAt: now }).where(eq(competitors.id, id));
  }
  return out;
}

/** Admin "Sync now": queue the dealership's integrations ahead of the schedule. Returns how many jobs were queued. */
export async function requestIntegrationSync(dealershipId: number): Promise<number> {
  const [d] = await db.select({ gsc: dealerships.gscProperty, place: dealerships.googlePlaceId }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!d) return 0;
  let n = 0;
  const now = new Date();
  if (d.gsc && gscConfigured() && (await enqueue("gsc_sync", dealershipId, {}, `gsc:${dealershipId}`, 40))) n++;
  if (d.place && placesConfigured() && (await enqueue("places_sync", dealershipId, {}, `places:${dealershipId}`, 40))) n++;
  const comps = await db.select({ id: competitors.id }).from(competitors).where(eq(competitors.dealershipId, dealershipId));
  for (const c of comps) {
    if (await enqueue("competitor_audit", dealershipId, { competitorId: c.id }, `competitor:${c.id}`, 45)) n++;
    await db.update(competitors).set({ lastAuditScheduledAt: now }).where(eq(competitors.id, c.id));
  }
  return n;
}

/** Queue the first audit of a newly added competitor. */
export async function requestCompetitorAudit(dealershipId: number, competitorId: number) {
  await enqueue("competitor_audit", dealershipId, { competitorId }, `competitor:${competitorId}`, 45);
  await db.update(competitors).set({ lastAuditScheduledAt: new Date() }).where(eq(competitors.id, competitorId));
}
