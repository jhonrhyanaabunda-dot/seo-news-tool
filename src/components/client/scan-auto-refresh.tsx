"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Rendered only while a scan is active: re-renders the server page every few
 * seconds so progress, and then the finished results, appear without a manual
 * refresh. Unmounts (and stops polling) as soon as the scan is no longer active.
 * Paused while the tab is hidden; refreshes immediately when it is shown again.
 */
// Scans take minutes and each refresh re-renders the whole report page on the server, so
// every 10s keeps progress current without making the page feel sluggish while it runs.
export function ScanAutoRefresh({ intervalMs = 10_000 }: { intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = setInterval(tick, intervalMs);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router, intervalMs]);
  return null;
}
