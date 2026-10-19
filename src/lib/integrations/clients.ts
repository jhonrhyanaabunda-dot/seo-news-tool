import "server-only";
import { GoogleApiError, GoogleTokenCache, type ServiceAccount } from "./google-auth";
import { GSC_SCOPE, gscApiError, parseSearchAnalytics, searchAnalyticsUrl, type GscRow, type SearchAnalyticsRequest } from "./gsc";
import { PLACE_DETAILS_FIELDS, PLACES_API_BASE, TEXT_SEARCH_FIELDS, TEXT_SEARCH_PAGE_SIZE, parsePlaceDetails, parseTextSearch, placesApiError, type PlaceCandidate, type PlaceDetails } from "./places";

/**
 * HTTPS clients for Search Console and Places API (New). Credentials and fetch
 * are passed in (the server wiring reads them from the environment), so tests
 * run these against a mocked fetch. API keys travel in headers, never in URLs
 * that could end up in logs.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchLike = (i, init) => fetch(i, init);
const TIMEOUT_MS = 30_000;

async function send(fetchImpl: FetchLike, url: string, init: RequestInit, label: string): Promise<{ status: number; body: string }> {
  try {
    const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return { status: res.status, body: await res.text() };
  } catch (err) {
    throw new GoogleApiError(`Could not reach ${label}: ${err instanceof Error ? err.message : "network error"}`, false);
  }
}

function json(body: string, label: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new GoogleApiError(`${label} returned an unreadable response.`, false);
  }
}

export function createGscClient(opts: { account: ServiceAccount; tokens: GoogleTokenCache; fetchImpl?: FetchLike }) {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  return {
    async query(property: string, request: SearchAnalyticsRequest): Promise<GscRow[]> {
      for (let attempt = 0; ; attempt++) {
        const token = await opts.tokens.getAccessToken(opts.account, GSC_SCOPE);
        const r = await send(fetchImpl, searchAnalyticsUrl(property), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(request) }, "Search Console");
        // A token revoked early: sign in again once.
        if (r.status === 401 && attempt === 0) {
          opts.tokens.invalidate(opts.account, GSC_SCOPE);
          continue;
        }
        if (r.status < 200 || r.status >= 300) throw gscApiError(r.status, r.body, opts.account.clientEmail);
        return parseSearchAnalytics(json(r.body, "Search Console"));
      }
    },
  };
}

export function createPlacesClient(opts: { apiKey: string; fetchImpl?: FetchLike }) {
  const fetchImpl = opts.fetchImpl ?? defaultFetch;
  return {
    async details(placeId: string): Promise<PlaceDetails> {
      const r = await send(fetchImpl, `${PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`, { method: "GET", headers: { "X-Goog-Api-Key": opts.apiKey, "X-Goog-FieldMask": PLACE_DETAILS_FIELDS.join(",") } }, "the Places API");
      if (r.status < 200 || r.status >= 300) throw placesApiError(r.status, r.body);
      return parsePlaceDetails(json(r.body, "The Places API"), placeId);
    },
    async search(textQuery: string): Promise<PlaceCandidate[]> {
      const r = await send(
        fetchImpl,
        `${PLACES_API_BASE}/places:searchText`,
        { method: "POST", headers: { "X-Goog-Api-Key": opts.apiKey, "X-Goog-FieldMask": TEXT_SEARCH_FIELDS.join(","), "Content-Type": "application/json" }, body: JSON.stringify({ textQuery, pageSize: TEXT_SEARCH_PAGE_SIZE }) },
        "the Places API",
      );
      if (r.status < 200 || r.status >= 300) throw placesApiError(r.status, r.body);
      return parseTextSearch(json(r.body, "The Places API"));
    },
  };
}
