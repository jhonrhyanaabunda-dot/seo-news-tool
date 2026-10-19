"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { assertAdmin } from "@/lib/auth/guards";
import { assertDealershipAccess } from "@/lib/auth/tenant";
import { db } from "@/lib/db";
import { reports } from "@/lib/db/schema";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/audit";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { emailReport, requestReport } from "@/lib/reports/service";

const idSchema = z.coerce.number().int().positive();

export async function generateReportAction(formData: FormData) {
  const id = idSchema.parse(formData.get("id"));
  const user = await assertDealershipAccess(id);
  const limit = await checkRateLimit({ key: `report:${user.id}`, limit: 20, windowSeconds: 3600 });
  if (!limit.allowed) redirect(`/dealerships/${id}?tab=reports&notice=rate-limited`);
  const { reportId, queued } = await requestReport(id, user.id);
  await recordAudit({ actor: user, action: "report.generate", target: { type: "dealership", id }, summary: queued ? "Generated a report" : "Asked for a report while one was running", details: { reportId } });
  revalidatePath(`/dealerships/${id}`);
  redirect(`/dealerships/${id}?tab=reports&report=${reportId}&notice=${queued ? "report-queued" : "report-running"}`);
}

export async function emailReportAction(formData: FormData) {
  const user = await assertAdmin();
  const reportId = idSchema.parse(formData.get("reportId"));
  const [report] = await db.select().from(reports).where(eq(reports.id, reportId)).limit(1);
  if (!report) redirect("/");
  const result = await emailReport(report);
  await logger.info("reports", "Report emailed", { by: user.email, reportId, ...result }, report.dealershipId);
  await recordAudit({ actor: user, action: "report.email", target: { type: "dealership", id: report.dealershipId }, summary: `Emailed report #${reportId}`, details: { reportId, ...result } });
  const notice = result.recipients === 0 ? "report-no-recipients" : result.failed ? "report-email-failed" : "report-emailed";
  redirect(`/dealerships/${report.dealershipId}?tab=reports&report=${reportId}&notice=${notice}`);
}
