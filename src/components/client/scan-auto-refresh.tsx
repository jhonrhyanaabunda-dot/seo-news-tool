"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { scanPhaseText } from "@/lib/seo/scan-phase";

type Status = { active: false } | { active: true; scanId: number; status: string; crawlPhase: string | null; stalled: boolean; done: number; total: number };

/**
 * Rendered only while a scan is active. Keeps the progress text current by
 * reading a small status endpoint, and re-renders the server page only when
 * that page would look different: the scan ended, or it stalled or recovered.
 * Paused while the tab is hidden, checks at once when it is shown again, and
 * slows down while a scan is stalled, because nothing is moving.
 */
const ACTIVE_MS = 10_000;
const STALLED_MS = 60_000;

export function ScanAutoRefresh({ dealershipId, initialText, stalled }: { dealershipId: number; initialText: string; stalled: boolean }) {
  const router = useRouter();
  const [live, setLive] = useState<string | null>(null);
  const wasStalled = useRef(stalled);
  useEffect(() => {
    wasStalled.current = stalled;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!stopped) timer = setTimeout(check, wasStalled.current ? STALLED_MS : ACTIVE_MS);
    };
    const check = async () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") {
        try {
          const res = await fetch(`/api/dealerships/${dealershipId}/scan-status`, { cache: "no-store" });
          if (res.ok) {
            const s = (await res.json()) as Status;
            if (stopped) return;
            if (!s.active) {
              stopped = true;
              router.refresh();
              return;
            }
            if (s.stalled !== wasStalled.current) {
              wasStalled.current = s.stalled;
              router.refresh();
            }
            setLive(scanPhaseText(s.status, s.crawlPhase, s));
          }
        } catch {
          // A failed check is not worth interrupting anyone for; the next one will tell.
        }
      }
      schedule();
    };
    schedule();
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [dealershipId, router, stalled]);
  return <>{live ?? initialText}</>;
}
