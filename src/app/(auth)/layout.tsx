import { existsSync } from "node:fs";
import path from "node:path";
import Image from "next/image";
import { CalendarCheck, FileBarChart, Mailbox } from "lucide-react";

/**
 * Shell for the signed-out pages: a photographic hero on the left, the card on
 * the right. Drop a photo at public/auth-hero.jpg (something A3 owns or has
 * licensed) and it is used automatically; until then the brand gradient shows.
 */
const HERO = "/auth-hero.jpg";
const heroExists = existsSync(path.join(process.cwd(), "public", "auth-hero.jpg"));

const HIGHLIGHTS = [
  { icon: FileBarChart, title: "Track performance", body: "39 checks per page" },
  { icon: CalendarCheck, title: "Catch problems", body: "Daily scans and alerts" },
  { icon: Mailbox, title: "Stay informed", body: "Monday SEO newsletter" },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <aside className="auth-hero relative hidden flex-col justify-between overflow-hidden p-10 text-white lg:flex xl:p-14">
        {heroExists && <Image src={HERO} alt="" fill priority sizes="55vw" className="object-cover" />}
        <div className="auth-hero-veil absolute inset-0" />

        <div className="relative">
          <div className="auth-rise inline-flex rounded-xl bg-white p-3 shadow-lg">
            <Image src="/a3brands-logo.png" alt="A3 Brands" width={1388} height={879} priority className="h-10 w-auto" />
          </div>
        </div>

        <div className="relative max-w-md">
          <h1 className="auth-rise text-[40px] font-bold leading-[1.1] tracking-tight" style={{ animationDelay: "120ms" }}>
            Smarter monitoring.
            <span className="mt-1 block text-blue-300">Better websites.</span>
          </h1>
          <p className="auth-rise mt-5 text-[17px] leading-relaxed text-blue-50/85" style={{ animationDelay: "200ms" }}>
            Your dealership SEO and news workspace, watching every site so nothing slips.
          </p>
        </div>

        <ul className="relative flex flex-wrap items-center gap-x-10 gap-y-5 border-t border-white/15 pt-6">
          {HIGHLIGHTS.map(({ icon: Icon, title, body }, i) => (
            <li key={title} className="auth-rise flex items-center gap-3" style={{ animationDelay: `${300 + i * 90}ms` }}>
              <Icon aria-hidden className="h-5 w-5 shrink-0 text-blue-300" />
              <span>
                <span className="block text-sm font-semibold leading-tight">{title}</span>
                <span className="block text-[13px] text-blue-100/70">{body}</span>
              </span>
            </li>
          ))}
        </ul>
      </aside>

      <main className="auth-canvas flex items-center justify-center p-5 sm:p-8">
        <div className="auth-card w-full max-w-md rounded-2xl bg-white p-7 sm:p-9">
          <div className="auth-rise mb-7 flex justify-center lg:hidden">
            <Image src="/a3brands-logo.png" alt="A3 Brands" width={1388} height={879} priority className="h-10 w-auto" />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
