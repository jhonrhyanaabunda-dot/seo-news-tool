"use client";

import Link, { useLinkStatus } from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { Building2, Gauge, Loader2, Newspaper, Rss, ServerCog, Settings, Users } from "lucide-react";

const ICONS = { dashboard: Gauge, news: Newspaper, seoNews: Rss, dealerships: Building2, settings: Settings, system: ServerCog, users: Users };

/**
 * Inline spinner driven by the parent <Link>'s own pending state, so a click
 * acknowledges immediately even when the destination is still being fetched.
 */
function NavPending() {
  const { pending } = useLinkStatus();
  if (!pending) return null;
  return <Loader2 aria-hidden className="ml-auto h-3.5 w-3.5 animate-spin text-blue-200" />;
}

export function NavLinks({ items }: { items: Array<{ href: string; label: string; icon: keyof typeof ICONS }> }) {
  const pathname = usePathname();
  return (
    <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
      {items.map((item) => {
        const active = item.href === "/" ? pathname === "/" || pathname.startsWith("/dealerships/") : pathname.startsWith(item.href);
        const Icon = ICONS[item.icon];
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={clsx(
                "flex items-center gap-2.5 whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition",
                active ? "bg-white/15 text-white" : "text-blue-100/80 hover:bg-white/10 hover:text-white",
              )}
            >
              <Icon aria-hidden className="h-4 w-4 shrink-0" />
              {item.label}
              <NavPending />
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
