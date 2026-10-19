import Link from "next/link";
import { CircleCheckBig, CircleDashed } from "lucide-react";
import { checklistComplete, type ChecklistItem } from "@/lib/onboarding/checklist";
import { Card, cn } from "@/components/ui";

/**
 * Admin dashboard checklist. Each item is derived from the system's real state
 * and links to where it is fixed. It disappears once every required item is
 * done; optional integrations alone never keep it on screen.
 */
export function GettingStarted({ items }: { items: ChecklistItem[] }) {
  if (checklistComplete(items)) return null;
  const done = items.filter((i) => i.done).length;
  return (
    <Card title="Getting started" description={`${done} of ${items.length} done. Each item reflects the current configuration.`} className="mb-6">
      <ul className="grid gap-2 md:grid-cols-2">
        {items.map((i) => (
          <li key={i.key}>
            <Link href={i.href} className={cn("flex items-start gap-3 rounded-md border px-3 py-2.5 transition hover:border-brand-300", i.done ? "border-slate-100 bg-slate-50" : "border-slate-200 bg-white")}>
              {i.done ? <CircleCheckBig aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" /> : <CircleDashed aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />}
              <span className="min-w-0">
                <span className={cn("block text-sm font-medium", i.done ? "text-slate-600" : "text-slate-900")}>
                  {i.label}
                  {i.optional && <span className="ml-1.5 text-xs font-normal text-slate-500">(optional)</span>}
                  <span className="sr-only">{i.done ? " — done" : " — to do"}</span>
                </span>
                <span className="block break-words text-xs text-slate-500">{i.detail}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
