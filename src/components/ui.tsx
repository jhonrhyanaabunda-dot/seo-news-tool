import Link from "next/link";
import clsx from "clsx";
import { ExternalLink as ExternalIcon } from "lucide-react";

export { clsx as cn };

export function PageHeader({ title, description, actions, breadcrumb }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <div className="mb-6">
      {breadcrumb && <div className="mb-2 text-sm text-slate-500">{breadcrumb}</div>}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description && <div className="mt-1 text-sm text-slate-600">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({ title, description, actions, children, className, bodyClassName }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={clsx("rounded-lg border border-slate-200 bg-white shadow-sm", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
          <div>
            {title && <h2 className="text-base font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={clsx("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

type Tone = "neutral" | "critical" | "warning" | "info" | "success" | "accent";
const toneClasses: Record<Tone, string> = {
  neutral: "bg-slate-100 text-slate-700 ring-slate-200",
  critical: "bg-red-50 text-red-800 ring-red-200",
  warning: "bg-amber-50 text-amber-800 ring-amber-200",
  info: "bg-sky-50 text-sky-800 ring-sky-200",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  accent: "bg-brand-50 text-brand-700 ring-brand-100",
};

export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: React.ReactNode; className?: string }) {
  return <span className={clsx("inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", toneClasses[tone], className)}>{children}</span>;
}

export function SeverityBadge({ severity }: { severity: string }) {
  if (severity === "critical") return <Badge tone="critical">Critical</Badge>;
  if (severity === "warning") return <Badge tone="warning">Warning</Badge>;
  return <Badge tone="info">Notice</Badge>;
}

const PRIORITY_TONE: Record<string, Tone> = { CRITICAL: "critical", HIGH: "warning", MEDIUM: "info", LOW: "neutral", PASS: "success" };
const PRIORITY_LABEL: Record<string, string> = { CRITICAL: "Critical", HIGH: "High", MEDIUM: "Medium", LOW: "Low", PASS: "Pass" };

/** Report priority: CRITICAL / HIGH / MEDIUM / LOW / PASS (see seo/priority.ts). */
export function PriorityBadge({ priority }: { priority: string }) {
  return <Badge tone={PRIORITY_TONE[priority] ?? "neutral"}>{PRIORITY_LABEL[priority] ?? priority}</Badge>;
}

export function scoreTone(score: number | null | undefined): Tone {
  if (score === null || score === undefined) return "neutral";
  if (score >= 85) return "success";
  if (score >= 65) return "warning";
  return "critical";
}

export function ScoreBadge({ score, size = "md" }: { score: number | null | undefined; size?: "md" | "lg" }) {
  const tone = scoreTone(score);
  const color = { success: "text-emerald-700", warning: "text-amber-700", critical: "text-red-700", neutral: "text-slate-400", info: "", accent: "" }[tone];
  return (
    <span className={clsx("font-semibold tabular-nums", color, size === "lg" ? "text-4xl" : "text-sm")} aria-label={score === null || score === undefined ? "Not scored" : `SEO score ${score} out of 100`}>
      {score ?? "—"}
      {score !== null && score !== undefined && <span className={clsx("font-normal text-slate-400", size === "lg" ? "text-lg" : "text-xs")}>/100</span>}
    </span>
  );
}

export function ScoreDelta({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined || delta === 0) return null;
  return <span className={clsx("text-xs font-medium tabular-nums", delta > 0 ? "text-emerald-700" : "text-red-700")}>{delta > 0 ? `▲ ${delta}` : `▼ ${Math.abs(delta)}`}</span>;
}

export type DealerStatus = "healthy" | "attention" | "critical" | "down" | "blocked" | "limited" | "partially_blocked" | "failed" | "scanning" | "not_scanned" | "paused";
export const DEALER_STATUS: Record<DealerStatus, { label: string; tone: Tone }> = {
  healthy: { label: "Healthy", tone: "success" },
  attention: { label: "Needs attention", tone: "warning" },
  critical: { label: "Critical issues", tone: "critical" },
  down: { label: "Website down", tone: "critical" },
  blocked: { label: "Protected / Unable to analyze", tone: "warning" },
  limited: { label: "Protected · limited check", tone: "warning" },
  partially_blocked: { label: "Partial · pages protected", tone: "warning" },
  failed: { label: "Scan failed", tone: "warning" },
  scanning: { label: "Scanning…", tone: "accent" },
  not_scanned: { label: "Not scanned yet", tone: "neutral" },
  paused: { label: "Monitoring off", tone: "neutral" },
};

export function StatusBadge({ status }: { status: DealerStatus }) {
  const s = DEALER_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

export function StatCard({ label, value, hint, tone = "neutral", href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone; href?: string }) {
  const accent = { neutral: "border-l-slate-300", critical: "border-l-red-500", warning: "border-l-amber-500", info: "border-l-sky-500", success: "border-l-emerald-500", accent: "border-l-brand-600" }[tone];
  const body = (
    <div className={clsx("h-full rounded-lg border border-l-4 border-slate-200 bg-white px-4 py-3 shadow-sm", accent, href && "transition hover:border-slate-300 hover:shadow")}>
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

/**
 * Low-emphasis counterpart to StatCard: context you check occasionally, laid out
 * in a single strip so it cannot compete with the headline numbers above it.
 */
export function MetaStat({ label, value, hint, tone = "neutral", href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone; href?: string }) {
  const dot = { neutral: "bg-slate-300", critical: "bg-red-500", warning: "bg-amber-500", info: "bg-sky-500", success: "bg-emerald-500", accent: "bg-brand-600" }[tone];
  const body = (
    <div className={clsx("px-3 py-2", href && "rounded-md transition hover:bg-slate-50")}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        <span aria-hidden className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-0.5 truncate text-sm font-semibold tabular-nums text-slate-900">{value}</div>
      {hint && <div className="truncate text-xs text-slate-400">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block">
      {body}
    </Link>
  ) : (
    body
  );
}

export function EmptyState({ title, description, action }: { title: string; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description && <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Notice({ tone = "info", children }: { tone?: Tone; children: React.ReactNode }) {
  return (
    <div role={tone === "critical" ? "alert" : "status"} className={clsx("mb-4 rounded-md px-4 py-3 text-sm ring-1 ring-inset", toneClasses[tone])}>
      {children}
    </div>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={clsx("inline-flex items-center gap-1 text-brand-700 hover:underline", className)}>
      <span className="break-all">{children ?? href}</span>
      <ExternalIcon aria-hidden className="h-3 w-3 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function Tabs({ tabs, active }: { tabs: Array<{ key: string; label: string; href: string; count?: number | null }>; active: string }) {
  return (
    <nav aria-label="Report sections" className="mb-5 border-b border-slate-200">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {tabs.map((t) => (
          <li key={t.key}>
            <Link
              href={t.href}
              aria-current={t.key === active ? "page" : undefined}
              className={clsx(
                "inline-flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium",
                t.key === active ? "border-brand-600 text-brand-700" : "border-transparent text-slate-600 hover:border-slate-300 hover:text-slate-900",
              )}
            >
              {t.label}
              {t.count !== undefined && t.count !== null && <span className="rounded-full bg-slate-100 px-1.5 text-xs text-slate-600">{t.count}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function Pagination({ page, totalPages, hrefFor }: { page: number; totalPages: number; hrefFor: (p: number) => string }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
      <span className="text-slate-500">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className="btn" href={hrefFor(page - 1)}>
            Previous
          </Link>
        ) : (
          <span className="btn opacity-50" aria-disabled>
            Previous
          </span>
        )}
        {page < totalPages ? (
          <Link className="btn" href={hrefFor(page + 1)}>
            Next
          </Link>
        ) : (
          <span className="btn opacity-50" aria-disabled>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

export function TableWrap({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-sm">
      <table className="table-base">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
