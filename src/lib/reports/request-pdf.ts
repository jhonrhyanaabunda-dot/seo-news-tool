import "server-only";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { dealerships, reportRenders } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/jobs/queue";
import { logger } from "@/lib/logger";
import { reportFilename } from "./pdf";
import { mintRenderToken, RENDER_TOKEN_TTL_MS } from "./render-token";

/**
 * Ask for a report PDF, and find out how an earlier ask is getting on.
 *
 * The worker polls for work and cannot be called, so a request is a job and the
 * page watches the row it created. Authorisation happens before any of this,
 * in the action, against the caller's own session — this module assumes it has
 * already been granted and never re-decides it.
 */

/** A render older than this is stale; the token has expired with it. */
const REQUEST_TTL_MS = RENDER_TOKEN_TTL_MS;

export type RenderStatus =
  | { state: "pending"; id: number }
  | { state: "ready"; id: number; filename: string; bytes: number }
  | { state: "failed"; id: number; reason: "unavailable" | "timeout" | "failed" };

/** Turns an internal failure into the one thing a dealership needs to know. */
function reasonFor(error: string | null): "unavailable" | "timeout" | "failed" {
  if (!error) return "failed";
  if (error.startsWith("browser_unavailable")) return "unavailable";
  if (error.startsWith("timeout")) return "timeout";
  return "failed";
}

export function describe(row: typeof reportRenders.$inferSelect): RenderStatus {
  if (row.status === "ready") return { state: "ready", id: row.id, filename: row.filename ?? "SEO-Report.pdf", bytes: row.bytes ?? 0 };
  if (row.status === "failed") return { state: "failed", id: row.id, reason: reasonFor(row.error) };
  return { state: "pending", id: row.id };
}

/**
 * Start a render, or join one already in flight.
 *
 * A double-clicked button must not start two Chromium renders, so a request
 * still pending for this dealership is returned as-is rather than queued again.
 */
export async function requestReportPdf(dealershipId: number, requestedBy: number | null, opts: { reuseInFlight?: boolean } = {}): Promise<RenderStatus> {
  // The monthly report asks for its own render (reuseInFlight: false) so that
  // collecting its bytes never takes a file a person is waiting to download.
  const [inFlight] =
    opts.reuseInFlight === false
      ? []
      : await db
          .select()
          .from(reportRenders)
          .where(and(eq(reportRenders.dealershipId, dealershipId), eq(reportRenders.status, "pending"), gt(reportRenders.expiresAt, new Date())))
          .orderBy(desc(reportRenders.id))
          .limit(1);
  if (inFlight) return describe(inFlight);

  const [dealer] = await db.select({ name: dealerships.name }).from(dealerships).where(eq(dealerships.id, dealershipId)).limit(1);
  if (!dealer) return { state: "failed", id: 0, reason: "failed" };

  const { token, tokenHash } = mintRenderToken();
  const expiresAt = new Date(Date.now() + REQUEST_TTL_MS);
  const requestKey = `pdf:${dealershipId}:${expiresAt.getTime()}`;
  const [row] = await db
    .insert(reportRenders)
    .values({ dealershipId, requestKey, tokenHash, filename: reportFilename(dealer.name, new Date()), expiresAt, requestedBy })
    .returning();

  // One attempt plus one retry: a cold browser or a dropped connection is worth
  // repeating, a broken report is not.
  await enqueueJob({
    type: "report_pdf",
    dealershipId,
    payload: { renderId: row.id, token },
    dedupeKey: `report-pdf:${row.id}`,
    priority: 5,
    maxAttempts: 2,
  });
  // No kick: only a runner with Chromium may claim this job, and the Vercel
  // tick is not one. The crawler worker polls every few seconds and takes it.
  await logger.info("reports", "Report PDF requested", { renderId: row.id, requestedBy }, dealershipId);
  return describe(row);
}

/** Where a render has got to. Scoped by dealership so an id alone proves nothing. */
export async function getRenderStatus(renderId: number, dealershipId: number): Promise<RenderStatus | null> {
  const [row] = await db
    .select()
    .from(reportRenders)
    .where(and(eq(reportRenders.id, renderId), eq(reportRenders.dealershipId, dealershipId)))
    .limit(1);
  return row ? describe(row) : null;
}

/**
 * Hand over the bytes once, then drop them.
 *
 * The row is a transport buffer: as soon as the browser has the file there is
 * no reason to keep a copy, and keeping one would quietly turn this table into
 * the report archive it is explicitly not.
 */
export async function takeRenderedPdf(renderId: number, dealershipId: number): Promise<{ pdf: Buffer; filename: string } | null> {
  const [row] = await db
    .select()
    .from(reportRenders)
    .where(and(eq(reportRenders.id, renderId), eq(reportRenders.dealershipId, dealershipId), eq(reportRenders.status, "ready")))
    .limit(1);
  if (!row?.pdf) return null;
  const pdf = Buffer.from(row.pdf);
  const filename = row.filename ?? "SEO-Report.pdf";
  await db.delete(reportRenders).where(eq(reportRenders.id, renderId));
  return { pdf, filename };
}

/**
 * Read a finished render without consuming it, for the monthly email: the
 * bytes must survive a send that fails part-way, so the retry can attach them
 * again. The caller discards the row once every recipient is served;
 * maintenance sweeps it otherwise.
 */
export async function peekRenderedPdf(renderId: number, dealershipId: number): Promise<{ pdf: Buffer; filename: string } | null> {
  const [row] = await db
    .select({ pdf: reportRenders.pdf, filename: reportRenders.filename })
    .from(reportRenders)
    .where(and(eq(reportRenders.id, renderId), eq(reportRenders.dealershipId, dealershipId), eq(reportRenders.status, "ready")))
    .limit(1);
  return row?.pdf ? { pdf: Buffer.from(row.pdf), filename: row.filename ?? "SEO-Report.pdf" } : null;
}

/** Drop a render the caller owns (delivered, or no longer wanted). */
export async function discardRender(renderId: number, dealershipId: number): Promise<void> {
  await db.delete(reportRenders).where(and(eq(reportRenders.id, renderId), eq(reportRenders.dealershipId, dealershipId)));
}

/** Housekeeping: anything expired, plus bytes a cancelled download left behind. */
export async function pruneReportRenders(): Promise<number> {
  const r = await db.execute(sql`delete from report_renders where expires_at < now() - interval '1 hour'`);
  return (r as unknown as { count?: number }).count ?? 0;
}
