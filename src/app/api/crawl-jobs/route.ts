import { NextResponse } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { kickProcessing } from "@/lib/jobs/kick";
import { CrawlJobError, createCrawlJob } from "@/lib/jobs/crawl-jobs";
import { logger, errorMessage } from "@/lib/logger";
import { bearerMatches } from "@/lib/security/bearer";
import { checkRateLimit } from "@/lib/security/rate-limit";

/**
 * POST /api/crawl-jobs — queue work for a dealership (machine-to-machine).
 *
 *   Authorization: Bearer <CRAWLER_API_TOKEN>
 *   { "dealershipId": 12, "jobType": "seo" | "news" | "report", "url": "https://www.dealer.com/" }
 *
 * 202 → { job: { id, jobType, status: QUEUED|RUNNING|COMPLETED|PARTIAL|FAILED, … }, created }
 * Poll GET /api/crawl-jobs/{id}. The request only enqueues: a U.S. crawler worker
 * claims SEO jobs from the database queue, so this never crawls inside a Vercel function.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  dealershipId: z.coerce.number().int().positive(),
  jobType: z.enum(["seo", "news", "report"]).default("seo"),
  url: z.string().url().optional(),
});

export async function POST(request: Request) {
  const token = env().CRAWLER_API_TOKEN;
  if (!token) return NextResponse.json({ error: "The crawl-job API is disabled (set CRAWLER_API_TOKEN)." }, { status: 503 });
  if (!bearerMatches(request, token)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) return NextResponse.json({ error: "Invalid request", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, { status: 400 });

  // Protects dealership websites from a misbehaving client, not just this server.
  const limit = await checkRateLimit({ key: `api:crawl-jobs:${parsed.data.dealershipId}:${parsed.data.jobType}`, limit: 6, windowSeconds: 3600 });
  if (!limit.allowed) return NextResponse.json({ error: "Too many jobs for this dealership; try again later." }, { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } });

  try {
    const { job, created } = await createCrawlJob(parsed.data);
    if (created) kickProcessing();
    return NextResponse.json({ job, created }, { status: 202 });
  } catch (err) {
    if (err instanceof CrawlJobError) return NextResponse.json({ error: err.message }, { status: err.status });
    await logger.error("api", "Crawl job creation failed", { error: errorMessage(err) });
    return NextResponse.json({ error: "The job could not be created." }, { status: 500 });
  }
}
