import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { reportRenders } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { errorMessage, logger } from "@/lib/logger";
import { looksLikePdf, reportFilename } from "./pdf-format";

/**
 * Renders the approved report document to PDF on the crawler worker.
 *
 * There is exactly one report presentation — the page at `/report/[id]` — and
 * this prints it. Nothing here knows what a report contains, which is the
 * point: the PDF cannot drift from the screen because it *is* the screen.
 *
 * The URL is built here from an id the application already authorised, never
 * from anything a caller supplied. A Playwright worker is a browser, so letting
 * a request choose the address would turn it into an open fetching service.
 */

/** A cold Chromium plus a dynamic page; beyond this something is wrong, not slow. */
const RENDER_TIMEOUT_MS = 90_000;
/** A report that renders to nothing is a failure, not an empty document. */
const MIN_PDF_BYTES = 1_000;
/** Far above a realistic report; a runaway render must not be streamed to anyone. */
const MAX_PDF_BYTES = 25 * 1024 * 1024;

export { looksLikePdf, reportFilename };

export class PdfRenderError extends Error {
  constructor(
    message: string,
    readonly kind: "browser_unavailable" | "timeout" | "invalid_output" | "failed",
  ) {
    super(message);
    this.name = "PdfRenderError";
  }
}

/** The only address this worker will ever open. */
export function reportUrlFor(dealershipId: number, token: string): string {
  const base = env().APP_URL.replace(/\/$/, "");
  return `${base}/report/${encodeURIComponent(String(dealershipId))}?rt=${encodeURIComponent(token)}`;
}

/**
 * Print one report. Runs only on a worker with Chromium; the Vercel runtime has
 * no browser and never calls this.
 *
 * The page is opened, printed to a buffer and closed in a `finally`, so a
 * failure cannot leak a page or a context. Bytes stay in memory — no temporary
 * file is written, which removes a whole class of cleanup bugs and keeps
 * repeated generation from filling the machine's disk.
 */
export async function renderReportPdf(dealershipId: number, token: string): Promise<Buffer> {
  const { withBrowserPage } = await import("@/lib/seo/browser-fetch");
  const url = reportUrlFor(dealershipId, token);

  let bytes: Buffer;
  try {
    bytes = await withBrowserPage(async (page) => {
      await page.goto(url, { waitUntil: "networkidle", timeout: RENDER_TIMEOUT_MS });
      // The document must be the report, not a redirect to the sign-in page.
      const marker = await page.locator(".print-doc").count();
      if (marker === 0) throw new PdfRenderError("The report page did not render (the render key may have expired).", "failed");
      await page.emulateMedia({ media: "print" });
      return Buffer.from(
        await page.pdf({ format: "A4", printBackground: true, margin: { top: "14mm", bottom: "14mm", left: "12mm", right: "12mm" } }),
      );
    }, RENDER_TIMEOUT_MS);
  } catch (err) {
    if (err instanceof PdfRenderError) throw err;
    const msg = errorMessage(err);
    if (/BrowserUnavailable|Chromium could not be started|playwright-core is not installed/i.test(msg)) {
      throw new PdfRenderError(msg, "browser_unavailable");
    }
    if (/timeout/i.test(msg)) throw new PdfRenderError(msg, "timeout");
    throw new PdfRenderError(msg, "failed");
  }

  if (!looksLikePdf(bytes)) throw new PdfRenderError("The renderer did not return a PDF.", "invalid_output");
  if (bytes.length < MIN_PDF_BYTES) throw new PdfRenderError(`The rendered PDF was only ${bytes.length} bytes.`, "invalid_output");
  if (bytes.length > MAX_PDF_BYTES) throw new PdfRenderError(`The rendered PDF was ${bytes.length} bytes, which is beyond the sane limit.`, "invalid_output");
  return bytes;
}

/**
 * The `report_pdf` job: render, store the bytes for collection, and record the
 * outcome either way so the waiting page stops waiting.
 */
export async function runReportPdfJob(renderId: number, token: string): Promise<{ bytes: number }> {
  const [row] = await db.select().from(reportRenders).where(eq(reportRenders.id, renderId)).limit(1);
  if (!row) return { bytes: 0 };
  if (row.status !== "pending") return { bytes: row.bytes ?? 0 }; // already settled; a retry must not render twice
  if (row.expiresAt.getTime() <= Date.now()) {
    await db.update(reportRenders).set({ status: "failed", error: "The request expired before it could be rendered.", completedAt: new Date() }).where(eq(reportRenders.id, renderId));
    return { bytes: 0 };
  }

  // The plaintext key travels in the job payload and nowhere else; the row
  // keeps only its hash. See render-token.ts.
  if (!token) throw new PdfRenderError("No render key was supplied for this job.", "failed");
  const started = Date.now();
  try {
    const pdf = await renderReportPdf(row.dealershipId, token);
    await db
      .update(reportRenders)
      .set({ status: "ready", pdf, bytes: pdf.length, durationMs: Date.now() - started, completedAt: new Date() })
      .where(eq(reportRenders.id, renderId));
    await logger.info("reports", "Report PDF rendered", { renderId, bytes: pdf.length, durationMs: Date.now() - started }, row.dealershipId);
    return { bytes: pdf.length };
  } catch (err) {
    const kind = err instanceof PdfRenderError ? err.kind : "failed";
    await db
      .update(reportRenders)
      .set({ status: "failed", error: `${kind}: ${errorMessage(err)}`.slice(0, 2000), durationMs: Date.now() - started, completedAt: new Date() })
      .where(eq(reportRenders.id, renderId));
    await logger.warn("reports", "Report PDF failed", { renderId, kind, error: errorMessage(err) }, row.dealershipId);
    throw err;
  }
}
