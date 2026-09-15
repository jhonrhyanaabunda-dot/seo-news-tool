import "server-only";
import { after } from "next/server";
import { runTick } from "./runner";
import { logger, errorMessage } from "@/lib/logger";

/**
 * Start processing queued work right after the current response is sent,
 * so manual actions ("Scan now", new dealership) begin within seconds
 * instead of waiting for the next cron tick. Uses Next.js `after()`, which
 * Vercel keeps alive via waitUntil. Remaining work continues on cron ticks.
 */
export function kickProcessing(budgetMs = 55_000) {
  after(async () => {
    try {
      await runTick({ budgetMs, concurrency: 2, schedule: true, role: "vercel" });
    } catch (err) {
      await logger.warn("jobs", "Background kick failed", { error: errorMessage(err) });
    }
  });
}
