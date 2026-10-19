"use client";

import { useState, useTransition } from "react";
import { findPlaceAction } from "@/app/actions/integrations";
import type { PlaceCandidate } from "@/lib/integrations/places";

export interface IntegrationFieldsConfig {
  /** Service account email admins add to Search Console (null when not configured). */
  serviceAccountEmail: string | null;
  placesEnabled: boolean;
}

/**
 * "Google data" fieldset of the dealership form: Search Console property and
 * Google listing (place id) with a "Find place" helper. Lives in the same
 * <form> as the rest of the dealership, so the helper uses a button, not a form.
 */
export function IntegrationFields({
  config,
  values,
  errors,
  searchDefault,
}: {
  config: IntegrationFieldsConfig;
  values: { gscProperty: string; googlePlaceId: string };
  errors: { gscProperty?: string; googlePlaceId?: string };
  searchDefault: string;
}) {
  const [placeId, setPlaceId] = useState(values.googlePlaceId);
  const [query, setQuery] = useState(searchDefault);
  const [results, setResults] = useState<PlaceCandidate[] | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searching, startSearch] = useTransition();

  const search = () =>
    startSearch(async () => {
      setSearchError(null);
      const r = await findPlaceAction(query);
      if (r.error) {
        setResults(null);
        setSearchError(r.error);
      } else setResults(r.candidates ?? []);
    });

  return (
    <fieldset className="grid gap-4 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-semibold text-slate-900">Google data</legend>
      <div className="sm:col-span-2">
        <label htmlFor="gscProperty" className="label">
          Search Console property
        </label>
        <input
          id="gscProperty"
          name="gscProperty"
          defaultValue={values.gscProperty}
          placeholder="sc-domain:example.com or https://www.example.com/"
          className="input font-mono text-sm"
          aria-invalid={errors.gscProperty ? true : undefined}
          aria-describedby={errors.gscProperty ? "gscProperty-error" : "gscProperty-hint"}
        />
        {errors.gscProperty ? (
          <p id="gscProperty-error" className="field-error" role="alert">
            {errors.gscProperty}
          </p>
        ) : (
          <p id="gscProperty-hint" className="field-hint">
            Copy it exactly from the Search Console property picker. Then, in Search Console → Settings → Users and permissions, add{" "}
            {config.serviceAccountEmail ? <strong className="break-all">{config.serviceAccountEmail}</strong> : "the service account email"} as a user (Restricted is enough).
            {!config.serviceAccountEmail && " Search Console is not connected yet: set the Google service account variables (see README)."}
          </p>
        )}
      </div>
      <div className="sm:col-span-2">
        <label htmlFor="googlePlaceId" className="label">
          Google listing (place id)
        </label>
        <input
          id="googlePlaceId"
          name="googlePlaceId"
          value={placeId}
          onChange={(e) => setPlaceId(e.target.value)}
          placeholder="ChIJ…"
          className="input font-mono text-sm"
          aria-invalid={errors.googlePlaceId ? true : undefined}
          aria-describedby={errors.googlePlaceId ? "googlePlaceId-error" : "googlePlaceId-hint"}
        />
        {errors.googlePlaceId ? (
          <p id="googlePlaceId-error" className="field-error" role="alert">
            {errors.googlePlaceId}
          </p>
        ) : (
          <p id="googlePlaceId-hint" className="field-hint">
            The dealership&apos;s Google Business Profile. Rating, reviews and listing details are read weekly.{" "}
            {config.placesEnabled ? "Use Find place to look it up." : "Google Places is not connected yet (GOOGLE_PLACES_API_KEY)."}
          </p>
        )}
        {config.placesEnabled && (
          <div className="mt-2 rounded-md border border-slate-200 p-3">
            <div className="flex flex-wrap items-center gap-2">
              <label htmlFor="placeSearch" className="sr-only">
                Search Google for the dealership
              </label>
              <input
                id="placeSearch"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  // Enter here searches; it must not submit the dealership form.
                  if (e.key === "Enter") {
                    e.preventDefault();
                    search();
                  }
                }}
                className="input min-w-0 flex-1"
                placeholder="Dealership name, city"
              />
              <button type="button" className="btn btn-sm" onClick={search} disabled={searching}>
                {searching ? "Searching…" : "Find place"}
              </button>
            </div>
            {searchError && (
              <p className="field-error" role="alert">
                {searchError}
              </p>
            )}
            {results && results.length > 0 && (
              <ul className="mt-2 divide-y divide-slate-100 text-sm" aria-label="Matching Google listings">
                {results.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
                    <div className="min-w-0">
                      <div className="font-medium text-slate-900">{c.name ?? "Unnamed place"}</div>
                      <div className="text-xs text-slate-500">
                        {c.address ?? "No address"}
                        {c.rating !== null && ` · ${c.rating.toFixed(1)} ★ (${c.reviewCount ?? 0})`}
                      </div>
                      {c.websiteUri && <div className="truncate text-xs text-slate-400">{c.websiteUri}</div>}
                    </div>
                    <button
                      type="button"
                      className={placeId === c.id ? "btn-primary btn-sm" : "btn btn-sm"}
                      onClick={() => setPlaceId(c.id)}
                      aria-pressed={placeId === c.id}
                    >
                      {placeId === c.id ? "Selected" : "Use this"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </fieldset>
  );
}
