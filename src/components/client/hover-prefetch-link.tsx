"use client";

import { useState, type ComponentProps } from "react";
import Link, { useLinkStatus } from "next/link";
import { Loader2 } from "lucide-react";

/**
 * A link that prefetches when someone shows intent (pointer over it, keyboard
 * focus, finger down) rather than whenever it scrolls into view. Prefetching
 * these routes runs database queries on a small connection pool, and a table of
 * dealerships would otherwise run them for every row nobody clicks.
 */
export function HoverPrefetchLink({ onMouseEnter, onFocus, onTouchStart, ...props }: ComponentProps<typeof Link>) {
  const [intent, setIntent] = useState(false);
  return (
    <Link
      {...props}
      prefetch={intent ? null : false}
      onMouseEnter={(e) => {
        setIntent(true);
        onMouseEnter?.(e);
      }}
      onFocus={(e) => {
        setIntent(true);
        onFocus?.(e);
      }}
      onTouchStart={(e) => {
        setIntent(true);
        onTouchStart?.(e);
      }}
    />
  );
}

/** Put inside a link: a spinner from the moment it is clicked until the destination starts to arrive. */
export function LinkPending({ className = "h-3.5 w-3.5" }: { className?: string }) {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Loader2 aria-hidden className={`link-pending animate-spin text-slate-400 ${className}`} />;
}
