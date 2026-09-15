import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getCrawlJob } from "@/lib/jobs/crawl-jobs";
import { bearerMatches } from "@/lib/security/bearer";

/** GET /api/crawl-jobs/{id} — job status and, for SEO jobs, result counts (Bearer CRAWLER_API_TOKEN). */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = env().CRAWLER_API_TOKEN;
  if (!token) return NextResponse.json({ error: "The crawl-job API is disabled (set CRAWLER_API_TOKEN)." }, { status: 503 });
  if (!bearerMatches(request, token)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const jobId = Number(id);
  if (!Number.isInteger(jobId) || jobId <= 0) return NextResponse.json({ error: "Invalid job id." }, { status: 400 });
  const job = await getCrawlJob(jobId);
  if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
  return NextResponse.json({ job });
}
