/**
 * Crawler regions. A dealership can prefer a region; SEO scan jobs are tagged
 * with it and only crawlers running in that region pick them up. Add regions
 * here (or via CRAWLER_EXTRA_REGIONS="eu-west:EU-West,ca-central:Canada") —
 * no other code changes are needed.
 */
export interface CrawlerRegion {
  id: string;
  label: string;
  /** Where to host a crawler for this region (documentation only). */
  hosting: string;
}

export const BUILT_IN_REGIONS: CrawlerRegion[] = [
  { id: "us-east", label: "US-East", hosting: "Vercel iad1 (Washington, D.C.) · Fly.io iad · Railway us-east4 · Render Virginia" },
  { id: "us-central", label: "US-Central", hosting: "Fly.io ord (Chicago) / dfw (Dallas) · Render Ohio" },
  { id: "us-west", label: "US-West", hosting: "Fly.io sjc (San Jose) / lax · Railway us-west2 · Render Oregon" },
];

export const FALLBACK_DEFAULT_REGION = "us-east";

/** Parse "id:Label,id2:Label 2" into extra regions. */
export function parseExtraRegions(spec: string | undefined | null): CrawlerRegion[] {
  if (!spec) return [];
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [id, label] = s.split(":").map((x) => x.trim());
      return { id: id.toLowerCase(), label: label || id, hosting: "Custom region" };
    })
    .filter((r) => /^[a-z0-9-]{2,40}$/.test(r.id));
}

export function allRegions(extraSpec?: string | null): CrawlerRegion[] {
  const extra = parseExtraRegions(extraSpec).filter((r) => !BUILT_IN_REGIONS.some((b) => b.id === r.id));
  return [...BUILT_IN_REGIONS, ...extra];
}

export function regionLabel(id: string | null | undefined, regions: Array<Pick<CrawlerRegion, "id" | "label">> = BUILT_IN_REGIONS): string {
  if (!id) return "Default";
  return regions.find((r) => r.id === id)?.label ?? id;
}

/** The region a dealership's scans run in: its preference if valid, else the default US region. */
export function resolveRegion(preferred: string | null | undefined, defaultRegion: string, regions: CrawlerRegion[]): string {
  if (preferred && regions.some((r) => r.id === preferred)) return preferred;
  return defaultRegion;
}
