import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  competitorSnapshots,
  competitors,
  dealershipIntegrations,
  dealerships,
  placeSnapshots,
  scanPages,
  seoScans,
  type CompetitorMetrics,
  type CompetitorSnapshot,
  type Dealership,
  type DealershipIntegration,
  type PlaceSnapshot,
} from "@/lib/db/schema";
import { requireDealershipAccess } from "@/lib/auth/tenant";
import { presentedScanOrder } from "@/lib/seo/presented-scan";
import { gscConfig, gscConfigured, placesConfigured } from "./config";
import { integrationRows, loadSearchPerformance, type SearchPerformance } from "./data";
import { listingFlags, reviewChange, type ListingFlag } from "./places";
import { metricsFromScanPage } from "./competitor-metrics";

/**
 * Read side of the data integrations for pages. Page-facing loaders re-check
 * dealership access themselves (tenancy is enforced at every read, not only by
 * the route). Job-side reads live in data.ts.
 */

export type { SearchPerformance };

/* ─────────────────────────── Google listing ─────────────────────────── */

export interface GoogleListing {
  placeId: string;
  status: DealershipIntegration | null;
  latest: PlaceSnapshot | null;
  change: ReturnType<typeof reviewChange>;
  history: Array<{ capturedAt: Date; reviewCount: number | null; rating: number | null }>;
  flags: ListingFlag[];
}

async function loadGoogleListing(dealer: Dealership, status: DealershipIntegration | null): Promise<GoogleListing | null> {
  if (!dealer.googlePlaceId) return null;
  const snaps = await db
    .select()
    .from(placeSnapshots)
    .where(and(eq(placeSnapshots.dealershipId, dealer.id), gte(placeSnapshots.capturedAt, new Date(Date.now() - 400 * 86_400_000))))
    .orderBy(asc(placeSnapshots.capturedAt));
  const latest = snaps[snaps.length - 1] ?? null;
  return {
    placeId: dealer.googlePlaceId,
    status,
    latest,
    change: reviewChange(snaps),
    history: snaps.map((s) => ({ capturedAt: s.capturedAt, reviewCount: s.reviewCount, rating: s.rating })),
    flags: latest ? listingFlags(latest, dealer.host) : [],
  };
}

/* ─────────────────────────── Competitors ─────────────────────────── */

export interface CompetitorColumn {
  id: number;
  name: string;
  websiteUrl: string;
  snapshot: Pick<CompetitorSnapshot, "status" | "error" | "capturedAt"> | null;
  metrics: CompetitorMetrics | null;
}

export interface CompetitorComparison {
  dealership: { metrics: CompetitorMetrics; scanCompletedAt: Date | null; detailsAvailable: boolean };
  competitors: CompetitorColumn[];
}

async function dealershipHomepageMetrics(dealer: Dealership, latestPlace: PlaceSnapshot | null) {
  const [scan] = await db
    .select({ id: seoScans.id, completedAt: seoScans.completedAt, siteChecks: seoScans.siteChecks, detailsRetained: seoScans.detailsRetained })
    .from(seoScans)
    .where(and(eq(seoScans.dealershipId, dealer.id), eq(seoScans.status, "completed")))
    .orderBy(...presentedScanOrder)
    .limit(1);
  const home = scan
    ? (
        await db
          .select({
            httpStatus: scanPages.httpStatus,
            finalUrl: scanPages.finalUrl,
            url: scanPages.url,
            title: scanPages.title,
            metaDescription: scanPages.metaDescription,
            h1: scanPages.h1,
            schemaTypes: scanPages.schemaTypes,
            htmlBytes: scanPages.htmlBytes,
            responseTimeMs: scanPages.responseTimeMs,
            hasViewport: scanPages.hasViewport,
          })
          .from(scanPages)
          .where(and(eq(scanPages.scanId, scan.id), eq(scanPages.status, "fetched"), or(eq(scanPages.pageType, "home"), eq(scanPages.depth, 0))))
          .orderBy(asc(scanPages.depth), asc(scanPages.id))
          .limit(1)
      )[0] ?? null
    : null;
  const ps = scan?.siteChecks?.pagespeed;
  return {
    metrics: metricsFromScanPage(home, { rating: latestPlace?.rating ?? null, reviewCount: latestPlace?.reviewCount ?? null, performance: ps && !ps.error ? ps.performance : null }),
    scanCompletedAt: scan?.completedAt ?? null,
    detailsAvailable: Boolean(home),
  };
}

async function loadCompetitors(dealer: Dealership, latestPlace: PlaceSnapshot | null): Promise<CompetitorComparison | null> {
  const list = await db.select().from(competitors).where(eq(competitors.dealershipId, dealer.id)).orderBy(asc(competitors.createdAt), asc(competitors.id));
  if (!list.length) return null;
  const latest = await db
    .selectDistinctOn([competitorSnapshots.competitorId])
    .from(competitorSnapshots)
    .where(
      inArray(
        competitorSnapshots.competitorId,
        list.map((c) => c.id),
      ),
    )
    .orderBy(competitorSnapshots.competitorId, desc(competitorSnapshots.capturedAt));
  const byId = new Map(latest.map((s) => [s.competitorId, s]));
  return {
    dealership: await dealershipHomepageMetrics(dealer, latestPlace),
    competitors: list.map((c) => {
      const s = byId.get(c.id) ?? null;
      // A blocked or failed audit may still carry listing data, which is not about the website.
      return { id: c.id, name: c.name, websiteUrl: c.websiteUrl, snapshot: s ? { status: s.status, error: s.error, capturedAt: s.capturedAt } : null, metrics: s ? s.metrics : null };
    }),
  };
}

/* ─────────────────────────── Page loader ─────────────────────────── */

export interface SearchTabData {
  gsc: { configured: boolean; problem: string | null; serviceAccountEmail: string | null };
  placesConfigured: boolean;
  search: SearchPerformance | null;
  listing: GoogleListing | null;
  competitors: CompetitorComparison | null;
}

export async function loadSearchTab(dealer: Dealership): Promise<SearchTabData> {
  await requireDealershipAccess(dealer.id);
  const status = await integrationRows(dealer.id);
  const [search, listing] = await Promise.all([loadSearchPerformance(dealer, status.gsc ?? null), loadGoogleListing(dealer, status.places ?? null)]);
  return {
    gsc: gscConfig(),
    placesConfigured: placesConfigured(),
    search,
    listing,
    competitors: await loadCompetitors(dealer, listing?.latest ?? null),
  };
}

/** Whether a dealership login gets the tab: only when something is connected for its dealership. */
export async function searchTabAvailable(dealer: Dealership): Promise<boolean> {
  if ((dealer.gscProperty && gscConfigured()) || (dealer.googlePlaceId && placesConfigured())) return true;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(competitors).where(eq(competitors.dealershipId, dealer.id));
  return n > 0;
}

/* ─────────────────────────── System page ─────────────────────────── */

export async function getIntegrationOverview() {
  const rows = await db
    .select({ id: dealerships.id, name: dealerships.name, gscProperty: dealerships.gscProperty, googlePlaceId: dealerships.googlePlaceId })
    .from(dealerships)
    .where(or(isNotNull(dealerships.gscProperty), isNotNull(dealerships.googlePlaceId)))
    .orderBy(asc(dealerships.name))
    .limit(500);
  const statuses = rows.length ? await db.select().from(dealershipIntegrations).where(inArray(dealershipIntegrations.dealershipId, rows.map((r) => r.id))) : [];
  const [{ n: competitorCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(competitors);
  return {
    dealerships: rows.map((r) => ({
      ...r,
      gsc: statuses.find((s) => s.dealershipId === r.id && s.kind === "gsc") ?? null,
      places: statuses.find((s) => s.dealershipId === r.id && s.kind === "places") ?? null,
    })),
    competitorCount,
  };
}
