import "server-only";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { emailConfigProblem } from "@/lib/email/config";
import { aiReportsConfigured } from "@/lib/reports/ai";
import { pageSpeedEnabled } from "@/lib/seo/pagespeed";
import { getSettings } from "@/lib/settings";
import type { GettingStartedState } from "@/lib/onboarding/checklist";

/** Real state behind the admin "Getting started" checklist. */
export async function getGettingStartedState(): Promise<GettingStartedState> {
  const [settings, counts] = await Promise.all([
    getSettings(),
    db.execute<{ dealerships: number; with_recipients: number; completed: number }>(sql`
      select
        (select count(*)::int from dealerships) as dealerships,
        (select count(*)::int from dealerships where jsonb_array_length(notification_emails) > 0) as with_recipients,
        (select count(*)::int from (select 1 from seo_scans where status = 'completed' limit 1) x) as completed
    `),
  ]);
  const row = (counts as unknown as Array<{ dealerships: number; with_recipients: number; completed: number }>)[0];
  return {
    dealerships: Number(row?.dealerships ?? 0),
    completedScans: Number(row?.completed ?? 0),
    managementRecipients: settings.managementRecipients.length,
    dealershipsWithRecipients: Number(row?.with_recipients ?? 0),
    emailProblem: emailConfigProblem(env()),
    pageSpeedKey: pageSpeedEnabled(),
    aiKey: aiReportsConfigured(),
  };
}

/** Whether this user has dismissed the first-visit welcome guide. */
export async function hasDismissedWelcome(userId: number): Promise<boolean> {
  const [u] = await db.select({ onboardedAt: users.onboardedAt }).from(users).where(eq(users.id, userId)).limit(1);
  return Boolean(u?.onboardedAt);
}

export async function markWelcomeDismissed(userId: number): Promise<void> {
  await db.update(users).set({ onboardedAt: new Date() }).where(eq(users.id, userId));
}
