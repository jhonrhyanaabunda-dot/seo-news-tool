/**
 * Google listing signals via the Places API (New) — pure helpers.
 *
 * The Business Profile API needs special approval from Google; Place Details
 * from the Places API (New) gives the public facts of the same listing
 * (rating, review count, status, website, phone). These are informational
 * signals for the dealership page and reports — never part of the SEO score.
 */
import type { PlaceSnapshotData } from "@/lib/db/schema";
import { GoogleApiError } from "./google-auth";

export const PLACES_API_BASE = "https://places.googleapis.com/v1";
/** Minimal field mask for the weekly snapshot (fields drive Places billing, so ask for nothing else). */
export const PLACE_DETAILS_FIELDS = ["id", "displayName", "rating", "userRatingCount", "businessStatus", "regularOpeningHours", "websiteUri", "nationalPhoneNumber", "formattedAddress", "googleMapsUri"];
export const TEXT_SEARCH_FIELDS = ["places.id", "places.displayName", "places.formattedAddress", "places.websiteUri", "places.rating", "places.userRatingCount"];
export const TEXT_SEARCH_PAGE_SIZE = 5;

/** Accepts a bare place id ("ChIJ…") or the resource name ("places/ChIJ…"). */
export function normalizePlaceId(input: string): string | null {
  const v = input.trim().replace(/^places\//, "");
  return /^[A-Za-z0-9_-]{10,300}$/.test(v) ? v : null;
}

export interface PlaceDetails {
  rating: number | null;
  reviewCount: number | null;
  businessStatus: string | null;
  data: PlaceSnapshotData;
}

const str = (v: unknown, max = 500): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parsePlaceDetails(json: unknown, requestedId: string): PlaceDetails {
  const p = (json ?? {}) as Record<string, unknown>;
  const rating = num(p.rating);
  const count = num(p.userRatingCount);
  const displayName = p.displayName as { text?: unknown } | undefined;
  return {
    rating: rating !== null && rating >= 0 && rating <= 5 ? rating : null,
    reviewCount: count !== null && count >= 0 ? Math.round(count) : null,
    businessStatus: str(p.businessStatus, 40),
    data: {
      placeId: str(p.id, 300) ?? requestedId,
      name: str(displayName?.text, 200),
      formattedAddress: str(p.formattedAddress),
      websiteUri: str(p.websiteUri, 1000),
      nationalPhoneNumber: str(p.nationalPhoneNumber, 40),
      googleMapsUri: str(p.googleMapsUri, 1000),
      hasOpeningHours: Boolean(p.regularOpeningHours && typeof p.regularOpeningHours === "object"),
    },
  };
}

export interface PlaceCandidate {
  id: string;
  name: string | null;
  address: string | null;
  websiteUri: string | null;
  rating: number | null;
  reviewCount: number | null;
}

export function parseTextSearch(json: unknown): PlaceCandidate[] {
  const places = (json as { places?: unknown })?.places;
  if (!Array.isArray(places)) return [];
  const out: PlaceCandidate[] = [];
  for (const raw of places) {
    const p = raw as Record<string, unknown>;
    const id = typeof p.id === "string" ? normalizePlaceId(p.id) : null;
    if (!id) continue;
    out.push({
      id,
      name: str((p.displayName as { text?: unknown } | undefined)?.text, 200),
      address: str(p.formattedAddress),
      websiteUri: str(p.websiteUri, 1000),
      rating: num(p.rating),
      reviewCount: num(p.userRatingCount),
    });
  }
  return out.slice(0, TEXT_SEARCH_PAGE_SIZE);
}

/** The search text for "Find place": dealership name plus city/state, which is how people search for it. */
export function placeSearchQuery(d: { name: string; city?: string | null; state?: string | null }): string {
  return [d.name, d.city, d.state].filter((s) => s && s.trim()).join(", ").slice(0, 200);
}

export function placesApiError(status: number, body: string): GoogleApiError {
  let message = "";
  let reason = "";
  try {
    const e = (JSON.parse(body) as { error?: { message?: string; status?: string } }).error;
    message = e?.message ?? "";
    reason = e?.status ?? "";
  } catch {
    /* not JSON */
  }
  const detail = message ? ` Google said: "${message.slice(0, 200)}"` : "";
  if (status === 403 || reason === "PERMISSION_DENIED") {
    return new GoogleApiError(`The Places API key was refused. Enable "Places API (New)" for the key's Google Cloud project (with billing) and allow that API in the key's restrictions.${detail}`, true, status);
  }
  if (status === 404 || reason === "NOT_FOUND") return new GoogleApiError(`Google has no place with this id; it may have been merged or removed. Use "Find place" to pick the listing again.${detail}`, true, status);
  if (status === 400) return new GoogleApiError(`The Places API rejected the request (is the place id complete?).${detail}`, true, status);
  if (status === 429) return new GoogleApiError(`Places API quota exceeded; it will be retried later.${detail}`, false, status);
  return new GoogleApiError(`Places API returned HTTP ${status}.${detail}`, status < 500, status);
}

/* ─────────────────────── Signals ─────────────────────── */

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  } catch {
    return null;
  }
}

export interface ListingFlag {
  key: "website_mismatch" | "no_website" | "not_operational" | "no_hours";
  tone: "warning" | "critical" | "info";
  message: string;
}

const STATUS_LABEL: Record<string, string> = {
  CLOSED_TEMPORARILY: "temporarily closed",
  CLOSED_PERMANENTLY: "permanently closed",
};

/**
 * Consistency checks between the Google listing and the dealership record.
 * Informational only. (A phone check against the site is not done: scans do
 * not store page text, and fetching the site again just for this is not worth
 * another request to the dealership's server.)
 */
export function listingFlags(snapshot: { businessStatus: string | null; data: PlaceSnapshotData }, dealershipHost: string): ListingFlag[] {
  const flags: ListingFlag[] = [];
  if (snapshot.businessStatus && snapshot.businessStatus !== "OPERATIONAL") {
    flags.push({ key: "not_operational", tone: "critical", message: `Google shows this business as ${STATUS_LABEL[snapshot.businessStatus] ?? snapshot.businessStatus.toLowerCase()}. Customers may think the dealership is closed.` });
  }
  const listingHost = hostOf(snapshot.data.websiteUri);
  const ownHost = dealershipHost.toLowerCase().replace(/^www\./, "");
  if (!listingHost) {
    flags.push({ key: "no_website", tone: "warning", message: "The Google listing has no website link." });
  } else if (listingHost !== ownHost && !listingHost.endsWith(`.${ownHost}`) && !ownHost.endsWith(`.${listingHost}`)) {
    flags.push({ key: "website_mismatch", tone: "warning", message: `The listing links to ${listingHost}, not the dealership website (${ownHost}).` });
  }
  if (!snapshot.data.hasOpeningHours) flags.push({ key: "no_hours", tone: "info", message: "The listing shows no opening hours." });
  return flags;
}

/**
 * Review-count change versus the snapshot taken about 30 days earlier: the
 * newest snapshot at least 21 days older than the latest one (weekly snapshots
 * drift by a day or two). Null without a comparable earlier snapshot.
 */
export function reviewChange(snapshots: Array<{ capturedAt: Date; reviewCount: number | null; rating: number | null }>): { reviews: number | null; rating: number | null; since: Date } | null {
  if (snapshots.length < 2) return null;
  const sorted = [...snapshots].sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime());
  const latest = sorted[0];
  const target = latest.capturedAt.getTime() - 30 * 86_400_000;
  const old = sorted
    .filter((s) => s.capturedAt.getTime() <= latest.capturedAt.getTime() - 21 * 86_400_000)
    .sort((a, b) => Math.abs(a.capturedAt.getTime() - target) - Math.abs(b.capturedAt.getTime() - target))[0];
  if (!old) return null;
  return {
    reviews: latest.reviewCount !== null && old.reviewCount !== null ? latest.reviewCount - old.reviewCount : null,
    rating: latest.rating !== null && old.rating !== null ? Math.round((latest.rating - old.rating) * 10) / 10 : null,
    since: old.capturedAt,
  };
}

/** Pick the search result that is this website's listing (competitor audits): same host, best reviewed first. */
export function matchCandidateByHost(candidates: PlaceCandidate[], host: string): PlaceCandidate | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  return candidates.find((c) => hostOf(c.websiteUri) === h) ?? null;
}
