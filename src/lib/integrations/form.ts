/**
 * Dealership form fields for the data integrations (validated server-side by
 * validateDealershipForm). Pure.
 */
import { validateGscProperty } from "./gsc";
import { normalizePlaceId } from "./places";

export const INTEGRATION_FORM_FIELDS = ["gscProperty", "googlePlaceId"] as const;

export type IntegrationFieldsResult =
  | { ok: true; data: { gscProperty?: string | null; googlePlaceId?: string | null } }
  | { ok: false; errors: Partial<Record<(typeof INTEGRATION_FORM_FIELDS)[number], string>> };

export function parseIntegrationFields(formData: { get(name: string): unknown }): IntegrationFieldsResult {
  const raw = (k: string) => {
    const v = formData.get(k);
    return typeof v === "string" ? v.trim() : "";
  };
  const errors: Partial<Record<(typeof INTEGRATION_FORM_FIELDS)[number], string>> = {};
  let gscProperty: string | null = null;
  const gsc = raw("gscProperty");
  if (gsc) {
    const r = validateGscProperty(gsc.slice(0, 300));
    if (r.ok) gscProperty = r.value;
    else errors.gscProperty = r.error;
  }
  let googlePlaceId: string | null = null;
  const place = raw("googlePlaceId");
  if (place) {
    googlePlaceId = normalizePlaceId(place);
    if (!googlePlaceId) errors.googlePlaceId = "That does not look like a Google place id (it usually starts with ChIJ). Use “Find place” to pick the listing.";
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  // A form that does not render these fields leaves the stored values alone instead of clearing them.
  const data: { gscProperty?: string | null; googlePlaceId?: string | null } = {};
  if (formData.get("gscProperty") !== null) data.gscProperty = gscProperty;
  if (formData.get("googlePlaceId") !== null) data.googlePlaceId = googlePlaceId;
  return { ok: true, data };
}
