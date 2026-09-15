import "server-only";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { settings } from "@/lib/db/schema";

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

export async function getPeriodMarker(key: string): Promise<string | null> {
  const [row] = await db.select().from(settings).where(eq(settings.key, `period:${key}`)).limit(1);
  return typeof row?.value === "string" ? row.value : null;
}

/** Local calendar parts in the configured timezone. */
export function localParts(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    weekday: "short",
  });
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    weekday: weekdays.indexOf(parts.weekday),
  };
}
