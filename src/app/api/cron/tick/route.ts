import { NextResponse } from "next/server";
import { bearerMatches } from "@/lib/security/bearer";
import { env } from "@/lib/env";
import { runTick } from "@/lib/jobs/runner";
import { logger, errorMessage } from "@/lib/logger";

/**
 * Scheduler heartbeat. Called by Vercel Cron (see vercel.json) or any external
 * scheduler with `Authorization: Bearer <CRON_SECRET>`. Each call schedules due
 * work and processes jobs for up to CRON_TICK_BUDGET_SECONDS.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Must stay above CRON_TICK_BUDGET_SECONDS. 300s works on every Vercel plan with Fluid Compute.
export const maxDuration = 300;

async function handle(request: Request) {
  if (!bearerMatches(request, env().CRON_SECRET)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const budgetMs = Math.min(env().CRON_TICK_BUDGET_SECONDS, maxDuration - 30) * 1000;
  try {
    const result = await runTick({ budgetMs, role: "vercel" });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    await logger.error("cron", "Cron tick failed", { error: errorMessage(err) });
    return NextResponse.json({ ok: false, error: "Tick failed; see system logs." }, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
