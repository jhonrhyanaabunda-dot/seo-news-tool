import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { inQuietHours, localParts } from "./local-time";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";
import { MAX_PERIOD_RELEASES, nextPeriodRelease } from "@/lib/jobs/period-retry";

/**
 * Application-wide settings stored in the `settings` table (key "app"),
 * editable from Admin → Settings. Defaults apply for any missing field, so
 * adding a new setting never requires a data migration.
 */
export const SCAN_INTERVAL_OPTIONS = [6, 12, 24, 48, 168] as const;
export const NEWS_INTERVAL_OPTIONS = [3, 6, 12, 24] as const;

export const settingsSchema = z.object({
  seoIntervalHours: z.coerce.number().int().min(1).max(720).default(24),
  newsIntervalHours: z.coerce.number().int().min(1).max(168).default(6),
  dailyDigestEnabled: z.boolean().default(true),
  dailyDigestHour: z.coerce.number().int().min(0).max(23).default(7),
  /** The weekly newsletter: top SEO industry news plus every dealership's week. Sent every week, even without dealership changes. */
  weeklyDigestEnabled: z.boolean().default(true),
  /** 0 = Sunday … 6 = Saturday */
  weeklyDigestWeekday: z.coerce.number().int().min(0).max(6).default(1),
  weeklyDigestHour: z.coerce.number().int().min(0).max(23).default(7),
  sendDigestWhenNoChanges: z.boolean().default(false),
  instantAlertsEnabled: z.boolean().default(true),
  /** Receive digests/alerts for every dealership (QA leads, management). */
  managementRecipients: z.array(z.string().email()).default([]),
  /** Receive only the weekly newsletter (covering every dealership), no daily summaries or alerts. */
  newsletterRecipients: z.array(z.string().email()).default([]),
  scoreChangeThreshold: z.coerce.number().int().min(1).max(50).default(8),
  newsAlertMinScore: z.coerce.number().int().min(1).max(100).default(50),
  newsLookbackDays: z.coerce.number().int().min(1).max(90).default(30),
  retentionDays: z.coerce.number().int().min(14).max(1095).default(180),
  schedulerPaused: z.boolean().default(false),
  /**
   * Overnight window in which a crawler outage is still detected and logged but
   * no email is sent. The monitoring machine is a Mac that sleeps, so a nightly
   * gap is expected rather than newsworthy; an outage that is still unresolved
   * when the window ends does send, which is the case worth waking up for.
   * Set both to the same hour to alert around the clock.
   */
  crawlerQuietHoursEnabled: z.boolean().default(true),
  crawlerQuietStartHour: z.coerce.number().int().min(0).max(23).default(21),
  crawlerQuietEndHour: z.coerce.number().int().min(0).max(23).default(7),
  /**
   * Administrators must use two-factor sign-in. An admin without it is sent to
   * Account to set it up and refused every admin page and action until they do
   * (enforced in `requireAdmin` / `assertAdmin`). Off by default so turning on
   * a deploy never locks anyone out.
   */
  requireAdminMfa: z.boolean().default(false),
  /**
   * Monthly SEO report email (with the PDF attached when the report worker is
   * online), per dealership, to its contacts and the management recipients.
   * Off by default. Day 1–28 so every month has it; sent at or after the hour
   * (APP_TIMEZONE) on or after that day, once per dealership per month.
   */
  monthlyReportEnabled: z.boolean().default(false),
  monthlyReportDay: z.coerce.number().int().min(1).max(28).default(1),
  monthlyReportHour: z.coerce.number().int().min(0).max(23).default(8),
});

export type AppSettings = z.infer<typeof settingsSchema>;

export async function getSettings(): Promise<AppSettings> {
  const [row] = await db.select().from(settings).where(eq(settings.key, "app")).limit(1);
  const parsed = settingsSchema.safeParse(row?.value ?? {});
  return parsed.success ? parsed.data : settingsSchema.parse({});
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next = settingsSchema.parse({ ...current, ...patch });
  await db
    .insert(settings)
    .values({ key: "app", value: next })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } });
  return next;
}

/**
 * Atomically claim a period marker (e.g. "digest:daily" → "2026-09-11").
 * Returns true only for the first caller for that period, which makes
 * digest/maintenance scheduling idempotent across overlapping cron ticks.
 */
export async function claimPeriod(key: string, period: string): Promise<boolean> {
  const rows = await db
    .insert(settings)
    .values({ key: `period:${key}`, value: period })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: period, updatedAt: new Date() },
      setWhere: sql`${settings.value} is distinct from ${JSON.stringify(period)}::jsonb`,
    })
    .returning({ key: settings.key });
  return rows.length > 0;
}

/**
 * Undo a claim so the next tick can claim the same period again. Clears the
 * marker only while it still holds `period`, so a newer period is never undone.
 */
export async function releasePeriod(key: string, period: string): Promise<void> {
  await db.delete(settings).where(and(eq(settings.key, `period:${key}`), sql`${settings.value} = ${JSON.stringify(period)}::jsonb`));
}

/**
 * Release a period claim after the job it guarded failed permanently, at most
 * `max` times per period (see jobs/period-retry.ts), so the next tick can
 * enqueue a fresh job. Returns whether the claim was released.
 *
 * The release budget lives in its own settings row and is updated under a row
 * lock, so two failures finishing at once cannot both spend the last release.
 */
export async function releaseFailedPeriod(key: string, period: string, max = MAX_PERIOD_RELEASES): Promise<boolean> {
  const markerKey = `period-retry:${key}`;
  const allowed = await db.transaction(async (tx) => {
    await tx.insert(settings).values({ key: markerKey, value: { period, releases: 0 } }).onConflictDoNothing();
    const [row] = await tx.select().from(settings).where(eq(settings.key, markerKey)).for("update").limit(1);
    const next = nextPeriodRelease(row?.value, period, max);
    if (next.allowed) await tx.update(settings).set({ value: next.marker, updatedAt: new Date() }).where(eq(settings.key, markerKey));
    return next.allowed;
  });
  if (allowed) await releasePeriod(key, period);
  return allowed;
}

export async function getPeriodMarker(key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, `period:${key}`)).limit(1);
  return typeof row?.value === "string" ? row.value : null;
}

// Re-exported so callers keep importing scheduling helpers from one place.
export { inQuietHours, localParts };
