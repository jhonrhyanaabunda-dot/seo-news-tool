import "server-only";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { performanceSnapshots, type PerformanceSnapshot } from "@/lib/db/schema";
import { pageSpeedEnabled } from "@/lib/seo/pagespeed";

/** Snapshots read for the Speed card: enough for a trend of the last few months at one per week. */
const SNAPSHOTS_READ = 40;
const TREND_POINTS = 12;

export interface SpeedData {
  /** PAGESPEED_API_KEY is set, so snapshots are being collected. */
  configured: boolean;
  /** Latest successful snapshot per page kind. */
  home: PerformanceSnapshot | null;
  vdp: PerformanceSnapshot | null;
  /** Latest attempt when it failed, so the card can say why nothing is shown. */
  lastError: string | null;
  /** Homepage performance scores, oldest first (successful snapshots only). */
  trend: Array<{ at: Date; performance: number }>;
}

/** Stored Core Web Vitals for one dealership. Read-only: nothing here calls Google. */
export async function getSpeedData(dealershipId: number): Promise<SpeedData> {
  const rows = await db
    .select()
    .from(performanceSnapshots)
    .where(eq(performanceSnapshots.dealershipId, dealershipId))
    .orderBy(desc(performanceSnapshots.capturedAt), desc(performanceSnapshots.id))
    .limit(SNAPSHOTS_READ);
  const ok = rows.filter((r) => !r.error);
  return {
    configured: pageSpeedEnabled(),
    home: ok.find((r) => r.pageKind === "home") ?? null,
    vdp: ok.find((r) => r.pageKind === "vdp") ?? null,
    lastError: rows[0]?.error ?? null,
    trend: ok
      .filter((r) => r.pageKind === "home" && r.performance !== null)
      .slice(0, TREND_POINTS)
      .reverse()
      .map((r) => ({ at: r.capturedAt, performance: r.performance! })),
  };
}
