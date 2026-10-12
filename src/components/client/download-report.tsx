"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Download, FileText, Loader2 } from "lucide-react";
import { reportPdfStatusAction, requestReportPdfAction, type PdfState } from "@/app/actions/report-pdf";
import type { RenderStatus } from "@/lib/reports/request-pdf";

/**
 * "Download PDF", and the waiting that comes with it.
 *
 * Rendering happens on A3's crawler machine, which polls for work, so the file
 * is not ready when the request returns. The button therefore asks once, then
 * watches the render it started until it is ready or has failed. The failure
 * copy says what the person can do about it and never why it broke.
 */

const POLL_MS = 2500;
/** Generation is seconds, not minutes; past this something is wrong. */
const GIVE_UP_MS = 3 * 60_000;

const MESSAGES: Record<"unavailable" | "timeout" | "failed", string> = {
  unavailable: "The report generator is temporarily unavailable. Please try again in a few minutes.",
  timeout: "The report took too long to produce. Please try again.",
  failed: "We couldn't generate the report right now. Please try again.",
};

export function DownloadReportButton({ dealershipId }: { dealershipId: number }) {
  const [state, action, pending] = useActionState<PdfState, FormData>(requestReportPdfAction, undefined);
  const [status, setStatus] = useState<RenderStatus | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const startedAt = useRef<number | null>(null);

  const requested = state?.status ?? null;
  const current = status ?? requested;

  useEffect(() => {
    if (!requested || requested.state !== "pending") return;
    startedAt.current ??= Date.now();
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - (startedAt.current ?? Date.now()) > GIVE_UP_MS) {
        setGaveUp(true);
        return;
      }
      const next = await reportPdfStatusAction(dealershipId, requested.id).catch(() => null);
      if (cancelled || !next) return;
      setStatus(next);
      if (next.state === "pending") timer = setTimeout(tick, POLL_MS);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [requested, dealershipId]);

  // A real anchor rather than a router navigation: this is a file download, and
  // the response must reach the browser's download handler untouched. The
  // server hands the bytes over once, so the link is followed automatically and
  // the button returns to its resting state.
  const downloadRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (current?.state !== "ready") return;
    downloadRef.current?.click();
    const t = setTimeout(() => setStatus(null), 1500);
    return () => clearTimeout(t);
  }, [current]);

  const waiting = pending || (current?.state === "pending" && !gaveUp);
  const failure = gaveUp ? MESSAGES.failed : current?.state === "failed" ? MESSAGES[current.reason] : state?.error;

  return (
    <div>
      {current?.state === "ready" && (
        <a ref={downloadRef} href={`/report/${dealershipId}/download/${current.id}`} download={current.filename} className="sr-only">
          Download {current.filename}
        </a>
      )}
      <form action={action}>
        <input type="hidden" name="id" value={dealershipId} />
        <button type="submit" className="btn" disabled={waiting}>
          {waiting ? (
            <>
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Generating your report…
            </>
          ) : current?.state === "ready" ? (
            <>
              <Download aria-hidden className="h-4 w-4" /> Your report is ready
            </>
          ) : (
            <>
              <FileText aria-hidden className="h-4 w-4" /> Download PDF
            </>
          )}
        </button>
      </form>
      {failure && (
        <p role="alert" className="mt-1.5 max-w-xs text-sm text-amber-800">
          {failure}
        </p>
      )}
      {waiting && <p className="mt-1.5 text-xs text-slate-500">This usually takes under a minute.</p>}
    </div>
  );
}
