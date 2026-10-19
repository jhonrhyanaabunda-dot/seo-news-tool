import Link from "next/link";
import { LogOut } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { isClient } from "@/lib/auth/tenant";
import { logoutAction } from "@/lib/auth/actions";
import { NavLinks } from "@/components/client/nav-links";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const items: Array<{ href: string; label: string; icon: "dashboard" | "news" | "seoNews" | "dealerships" | "settings" | "system" | "users" | "audit" }> = [
    { href: "/", label: "Dashboard", icon: "dashboard" },
    { href: "/news", label: "News", icon: "news" },
  ];
  // The industry feed is A3's own trade reading, not a dealership deliverable.
  if (!isClient(user)) items.push({ href: "/seo-news", label: "SEO news", icon: "seoNews" });
  if (user.role === "admin") {
    items.push(
      { href: "/admin/dealerships", label: "Dealerships", icon: "dealerships" },
      { href: "/admin/settings", label: "Settings", icon: "settings" },
      { href: "/admin/users", label: "Users", icon: "users" },
      { href: "/admin/system", label: "System", icon: "system" },
      { href: "/admin/audit", label: "Audit log", icon: "audit" },
    );
  }
  const roleLabel = user.role === "admin" ? "Administrator" : user.role === "client" ? "Dealership" : "Viewer";
  return (
    <div className="md:flex">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="bg-brand-950 text-white md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col md:border-r md:border-white/5">
        <div className="flex items-center justify-between gap-3 px-4 py-3.5 md:px-5 md:py-5">
          <Link href="/" className="block min-w-0">
            <div className="text-xs font-medium text-blue-300/90">A3 Brands</div>
            <div className="truncate text-[15px] font-semibold leading-tight tracking-tight">SEO &amp; News Monitor</div>
          </Link>
          {/* Phones: account and sign-out live in the top bar, the sidebar footer is hidden. */}
          <div className="flex items-center gap-3 md:hidden">
            <Link href="/account" aria-label={`Account: ${user.name}`} className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white">
              {initials(user.name)}
            </Link>
            <form action={logoutAction}>
              <button type="submit" aria-label="Sign out" className="flex h-8 w-8 items-center justify-center rounded-md text-blue-100/80 hover:bg-white/10 hover:text-white">
                <LogOut aria-hidden className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
        <nav aria-label="Main" className="px-2 pb-2 md:flex-1 md:px-3 md:pb-3">
          <NavLinks items={items} />
        </nav>
        <div className="hidden border-t border-white/10 p-3 md:block">
          <div className="flex items-center gap-3 rounded-md px-2 py-2">
            <Link href="/account" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-semibold text-white hover:bg-white/15" aria-hidden tabIndex={-1}>
              {initials(user.name)}
            </Link>
            <div className="min-w-0 flex-1">
              <Link href="/account" className="block truncate text-sm font-medium text-white hover:underline">
                {user.name}
              </Link>
              <div className="truncate text-xs text-blue-100/60" title={user.email}>
                {roleLabel}
              </div>
            </div>
            <form action={logoutAction}>
              <button type="submit" aria-label="Sign out" title="Sign out" className="flex h-8 w-8 items-center justify-center rounded-md text-blue-100/70 transition-colors hover:bg-white/10 hover:text-white">
                <LogOut aria-hidden className="h-4 w-4" />
              </button>
            </form>
          </div>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
          {children}
        </main>
      </div>
    </div>
  );
}
