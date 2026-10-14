import Link from "next/link";
import clsx from "clsx";
import { CheckCircle2, CircleAlert, ExternalLink as ExternalIcon, Info, TriangleAlert } from "lucide-react";

export { clsx as cn };

/*
 * Design system primitives. Colour carries meaning only: brand blue for
 * actions and selection, and emerald / amber / red strictly for status, always
 * paired with a word so nothing depends on colour alone.
 */

export function PageHeader({ title, description, actions, breadcrumb }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; breadcrumb?: React.ReactNode }) {
  return (
    <div className="mb-7">
      {breadcrumb && <div className="mb-2 text-sm text-slate-500">{breadcrumb}</div>}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-slate-900">{title}</h1>
          {description && <div className="mt-1.5 text-sm text-slate-500">{description}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({ title, description, actions, children, className, bodyClassName }: { title?: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section className={clsx("min-w-0 rounded-lg border border-slate-200 bg-white shadow-[var(--shadow-card)]", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
            {description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className={clsx("p-5", bodyClassName)}>{children}</div>
    </section>
  );
}

export type Tone = "neutral" | "critical" | "warning" | "info" | "success" | "accent";
const toneClasses: Record<Tone, string> = {
  neutral: "bg-slate-50 text-slate-700 ring-slate-200",
  critical: "bg-red-50 text-red-800 ring-red-200/80",
  warning: "bg-amber-50 text-amber-900 ring-amber-200/80",
  info: "bg-sky-50 text-sky-900 ring-sky-200/80",
  success: "bg-emerald-50 text-emerald-800 ring-emerald-200/80",
  accent: "bg-brand-50 text-brand-700 ring-brand-200/70",
};
const dotClasses: Record<Tone, string> = {
  neutral: "bg-slate-400",
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-sky-500",
  success: "bg-emerald-500",
  accent: "bg-brand-500",
};

export function Badge({ tone = "neutral", children, className, dot = false }: { tone?: Tone; children: React.ReactNode; className?: string; /** A leading status dot; used for states rather than labels. */ dot?: boolean }) {
  return (
    <span className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset", toneClasses[tone], className)}>
      {dot && <span aria-hidden className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", dotClasses[tone])} />}
      {children}
    </span>
  );
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
    <span className={clsx("font-semibold tabular-nums", color, size === "lg" ? "text-4xl tracking-tight" : "text-sm")} aria-label={score === null || score === undefined ? "Not scored" : `SEO score ${score} out of 100`}>
      {score ?? "—"}
      {score !== null && score !== undefined && <span className={clsx("font-normal text-slate-400", size === "lg" ? "text-lg" : "text-xs")}>/100</span>}
    </span>
  );
}

export function ScoreDelta({ delta }: { delta: number | null | undefined }) {
  if (delta === null || delta === undefined || delta === 0) return null;
  return (
    <span className={clsx("inline-flex items-center text-xs font-medium tabular-nums", delta > 0 ? "text-emerald-700" : "text-red-700")}>
      {delta > 0 ? `▲ ${delta}` : `▼ ${Math.abs(delta)}`}
    </span>
  );
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
  return (
    <Badge tone={s.tone} dot>
      {s.label}
    </Badge>
  );
}

/** Headline figure. Tone appears as a small status dot beside the label, not as a coloured stripe. */
export function StatCard({ label, value, hint, tone = "neutral", href }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: Tone; href?: string }) {
  const body = (
    <div className={clsx("h-full rounded-lg border border-slate-200 bg-white px-5 py-4 shadow-[var(--shadow-card)]", href && "transition-colors hover:border-slate-300 hover:bg-slate-50/60")}>
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <span aria-hidden className={clsx("h-2 w-2 shrink-0 rounded-full", dotClasses[tone])} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-slate-900">{value}</div>
      {hint && <div className="mt-1 text-xs text-slate-500">{hint}</div>}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full rounded-lg">
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
  const body = (
    <div className={clsx("px-4 py-2.5", href && "rounded-md transition-colors hover:bg-slate-50")}>
      <div className="flex items-center gap-1.5 text-xs text-slate-500">
        <span aria-hidden className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", tone === "neutral" ? "bg-slate-300" : dotClasses[tone])} />
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1 truncate text-sm font-semibold tabular-nums text-slate-900">{value}</div>
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
    <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50/50 px-6 py-10 text-center">
      <p className="text-sm font-semibold text-slate-800">{title}</p>
      {description && <p className="mx-auto mt-1.5 max-w-md text-sm leading-relaxed text-slate-500">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

const NOTICE_ICON: Record<Tone, React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>> = {
  neutral: Info,
  info: Info,
  accent: Info,
  success: CheckCircle2,
  warning: TriangleAlert,
  critical: CircleAlert,
};
const noticeClasses: Record<Tone, string> = {
  neutral: "border-slate-200 bg-white text-slate-700",
  info: "border-sky-200 bg-sky-50/70 text-sky-950",
  accent: "border-brand-200 bg-brand-50/70 text-brand-900",
  success: "border-emerald-200 bg-emerald-50/70 text-emerald-950",
  warning: "border-amber-200 bg-amber-50/70 text-amber-950",
  critical: "border-red-200 bg-red-50/70 text-red-950",
};
const noticeIconClasses: Record<Tone, string> = {
  neutral: "text-slate-400",
  info: "text-sky-600",
  accent: "text-brand-600",
  success: "text-emerald-600",
  warning: "text-amber-600",
  critical: "text-red-600",
};

export function Notice({ tone = "info", children }: { tone?: Tone; children: React.ReactNode }) {
  const Icon = NOTICE_ICON[tone];
  return (
    <div role={tone === "critical" ? "alert" : "status"} className={clsx("mb-4 flex gap-3 rounded-lg border px-4 py-3 text-sm leading-relaxed", noticeClasses[tone])}>
      <Icon aria-hidden className={clsx("mt-0.5 h-4 w-4 shrink-0", noticeIconClasses[tone])} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children?: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className={clsx("inline-flex items-center gap-1 text-brand-700 hover:text-brand-800 hover:underline", className)}>
      <span className="break-all">{children ?? href}</span>
      <ExternalIcon aria-hidden className="h-3 w-3 shrink-0" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

export function Tabs({ tabs, active }: { tabs: Array<{ key: string; label: string; href: string; count?: number | null }>; active: string }) {
  return (
    <nav aria-label="Report sections" className="mb-6 border-b border-slate-200">
      <ul className="-mb-px flex gap-5 overflow-x-auto">
        {tabs.map((t) => {
          const on = t.key === active;
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={clsx(
                  "inline-flex items-center gap-2 whitespace-nowrap border-b-2 py-2.5 text-sm font-medium transition-colors",
                  on ? "border-brand-600 text-slate-900" : "border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-800",
                )}
              >
                {t.label}
                {t.count !== undefined && t.count !== null && (
                  <span className={clsx("rounded-md px-1.5 py-px text-xs tabular-nums", on ? "bg-brand-50 text-brand-700" : "bg-slate-100 text-slate-500")}>{t.count}</span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export function Pagination({ page, totalPages, hrefFor }: { page: number; totalPages: number; hrefFor: (p: number) => string }) {
  if (totalPages <= 1) return null;
  return (
    <nav aria-label="Pagination" className="mt-4 flex items-center justify-between text-sm">
      <span className="text-slate-500 tabular-nums">
        Page {page} of {totalPages}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link className="btn btn-sm" href={hrefFor(page - 1)}>
            Previous
          </Link>
        ) : (
          <span className="btn btn-sm pointer-events-none opacity-50" aria-disabled>
            Previous
          </span>
        )}
        {page < totalPages ? (
          <Link className="btn btn-sm" href={hrefFor(page + 1)}>
            Next
          </Link>
        ) : (
          <span className="btn btn-sm pointer-events-none opacity-50" aria-disabled>
            Next
          </span>
        )}
      </div>
    </nav>
  );
}

export function TableWrap({ children, caption }: { children: React.ReactNode; caption: string }) {
  return (
    // relative: screen-reader-only labels are absolutely positioned; without it they escape the scroll box and widen the page on phones.
    <div className="relative overflow-x-auto rounded-lg border border-slate-200 bg-white shadow-[var(--shadow-card)]">
      <table className="table-base">
        <caption className="sr-only">{caption}</caption>
        {children}
      </table>
    </div>
  );
}
