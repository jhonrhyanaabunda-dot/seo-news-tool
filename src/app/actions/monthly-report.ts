"use server";

import { randomBytes } from "node:crypto";
import { redirect } from "next/navigation";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { assertDealershipAccess } from "@/lib/auth/tenant";
import { env } from "@/lib/env";
import { enqueueJob } from "@/lib/jobs/queue";
import { kickProcessing } from "@/lib/jobs/kick";
import { recordAudit } from "@/lib/audit";
import { localParts } from "@/lib/local-time";
import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { manualMonthlyReportJob } from "@/lib/reports/monthly-schedule";

const idSchema = z.coerce.number().int().positive();

/**
 * Admin testing: build and send this month's monthly report for one dealership
 * now. "Only me" (the default) sends to the admin's own address; "recipients"
 * sends to the dealership's contacts and management, exactly like the
 * scheduled run. Either way it uses its own email dedupe keys and holds no
 * period claim, so the scheduled send for the month still goes out.
 */
export async function sendMonthlyReportNowAction(formData: FormData) {
  const user = await assertAdmin();
  const id = idSchema.parse(formData.get("id"));
  await assertDealershipAccess(id);
  const target = formData.get("to") === "recipients" ? "recipients" : "me";
  const limit = await checkRateLimit({ key: `monthly-now:${user.id}`, limit: 5, windowSeconds: 3600 });
  if (!limit.allowed) redirect(`/dealerships/${id}?tab=reports&notice=rate-limited`);
  const month = localParts(new Date(), env().APP_TIMEZONE).date.slice(0, 7);
  const nonce = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  await enqueueJob(manualMonthlyReportJob(id, month, user.id, target === "me" ? user.email : null, nonce));
  await logger.info("admin", "Monthly report send requested", { by: user.email, month, target }, id);
  await recordAudit({ actor: user, action: "report.monthly_now", target: { type: "dealership", id }, summary: target === "me" ? `Sent the ${month} monthly report to self` : `Sent the ${month} monthly report to the dealership's recipients`, details: { month, target } });
  kickProcessing();
  redirect(`/dealerships/${id}?tab=reports&notice=${target === "me" ? "monthly-queued-me" : "monthly-queued"}`);
}
