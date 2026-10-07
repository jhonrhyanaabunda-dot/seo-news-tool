import Link from "next/link";
import { cookies } from "next/headers";
import { LogOut } from "lucide-react";
import { requireUser } from "@/lib/auth/guards";
import { logoutAction } from "@/lib/auth/actions";
import { NavLinks } from "@/components/client/nav-links";
import { SignInIntro } from "@/components/client/sign-in-intro";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const justSignedIn = (await cookies()).get("a3_intro")?.value === "1";
  const items: Array<{ href: string; label: string; icon: "dashboard" | "news" | "seoNews" | "dealerships" | "settings" | "system" | "users" }> = [
    { href: "/", label: "Dashboard", icon: "dashboard" },
    { href: "/news", label: "News", icon: "news" },
    { href: "/seo-news", label: "SEO news", icon: "seoNews" },
  ];
  if (user.role === "admin") {
    items.push(
      { href: "/admin/dealerships", label: "Dealerships", icon: "dealerships" },
      { href: "/admin/settings", label: "Settings", icon: "settings" },
      { href: "/admin/users", label: "Users", icon: "users" },
      { href: "/admin/system", label: "System", icon: "system" },
    );
  }
  return (
    <div className={`md:flex ${justSignedIn ? "app-rise" : ""}`}>
      {justSignedIn && <SignInIntro name={user.name} />}
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <aside className="bg-brand-900 text-white md:sticky md:top-0 md:flex md:h-screen md:w-60 md:shrink-0 md:flex-col">
        <div className="flex items-center justify-between px-4 py-4 md:block">
          <Link href="/" className="block">
            <div className="text-[11px] font-semibold uppercase tracking-[0.14em] text-blue-300">A3 Brands</div>
            <div className="text-base font-semibold leading-tight">SEO &amp; News Monitor</div>
          </Link>
        </div>
        <nav aria-label="Main" className="px-2 pb-3 md:flex-1">
          <NavLinks items={items} />
        </nav>
        <div className="hidden border-t border-white/10 px-4 py-3 text-sm md:block">
          <Link href="/account" className="block truncate font-medium text-white hover:underline">
            {user.name}
          </Link>
          <div className="truncate text-xs text-blue-200/80">
            {user.email} · {user.role === "admin" ? "Administrator" : "Viewer"}
          </div>
          <form action={logoutAction} className="mt-2">
            <button type="submit" className="inline-flex items-center gap-1.5 text-xs text-blue-100 hover:text-white">
              <LogOut aria-hidden className="h-3.5 w-3.5" /> Sign out
            </button>
          </form>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-end gap-3 border-b border-slate-200 bg-white px-4 py-2 text-sm md:hidden">
          <Link href="/account" className="text-slate-700">
            {user.name}
          </Link>
          <form action={logoutAction}>
            <button type="submit" className="text-slate-500 hover:text-slate-900">
              Sign out
            </button>
          </form>
        </div>
        <main id="main" className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          {children}
        </main>
      </div>
    </div>
  );
}
