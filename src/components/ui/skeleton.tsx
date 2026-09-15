/** Shared skeleton atoms so every route's loading state matches its real layout. */
import clsx from "clsx";

export function SkelLine({ className }: { className?: string }) {
  return <div className={clsx("h-4 rounded bg-slate-200", className)} />;
}

export function SkelCard({ className }: { className?: string }) {
  return <div className={clsx("rounded-lg border border-slate-200 bg-white p-4 shadow-sm", className)} />;
}

export function SkelHeader() {
  return (
    <div className="mb-6 space-y-2">
      <SkelLine className="h-7 w-56" />
      <SkelLine className="h-4 w-80 bg-slate-100" />
    </div>
  );
}

export function SkelTable({ rows = 6, cols = 7 }: { rows?: number; cols?: number }) {
  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="flex gap-4 border-b border-slate-100 bg-slate-50 px-3 py-2.5">
        {Array.from({ length: cols }).map((_, i) => (
          <SkelLine key={i} className="h-3 flex-1 bg-slate-200" />
        ))}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex gap-4 border-b border-slate-100 px-3 py-3.5 last:border-0">
          {Array.from({ length: cols }).map((_, i) => (
            <SkelLine key={i} className={clsx("flex-1", i === 0 ? "bg-slate-200" : "bg-slate-100")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div role="status" aria-live="polite" className="animate-pulse">
      {children}
      <span className="sr-only">Loading…</span>
    </div>
  );
}
