import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { CalendarCheck, Mailbox, ShieldCheck } from "lucide-react";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

/** What the product actually does. Each figure is checked against the code: 39 rules in seo/checks/config.ts, 7 categories, 8 enabled publications. */
const PROOF = [
  { icon: ShieldCheck, title: "39 SEO checks per page", body: "Titles, headings, links, images, structured data and more, scored 0 to 100 across 7 categories." },
  { icon: CalendarCheck, title: "Every dealership, every day", body: "Scheduled scans with alerts the moment something critical breaks." },
  { icon: Mailbox, title: "Monday SEO newsletter", body: "The week's top stories from 8 SEO publications, plus each store's results." },
];

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <div className="auth-bg flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="auth-card grid w-full max-w-3xl overflow-hidden rounded-2xl bg-white md:grid-cols-[1fr_1.05fr]">
        <div className="p-7 sm:p-8">
          {/* Phones never see the brand panel below, so the logo is carried here instead. */}
          <div className="auth-rise mb-6 inline-flex rounded-xl bg-white p-2.5 shadow-sm ring-1 ring-slate-200 md:hidden">
            <Image src="/a3brands-logo.png" alt="A3 Brands" width={1388} height={879} priority className="h-9 w-auto" />
          </div>
          <h2 className="auth-rise text-xl font-semibold text-slate-900">Sign in</h2>
          <p className="auth-rise mt-1.5 text-sm text-slate-500" style={{ animationDelay: "70ms" }}>
            Enter your email and password to continue.
          </p>
          <div className="mt-6">
            <LoginForm next={next} />
          </div>
        </div>

        <aside className="auth-panel hidden flex-col gap-6 p-8 text-white md:flex">
          <div>
            <div className="auth-rise inline-flex rounded-xl bg-white p-3 shadow-lg" style={{ animationDelay: "160ms" }}>
              <Image src="/a3brands-logo.png" alt="" width={1388} height={879} className="h-9 w-auto" />
            </div>
            <h1 className="auth-rise mt-5 text-[22px] font-semibold leading-tight" style={{ animationDelay: "230ms" }}>Your SEO monitoring portal</h1>
          </div>

          <ul className="flex-1 space-y-4">
            {PROOF.map(({ icon: Icon, title, body }, i) => (
              <li key={title} className="auth-rise flex gap-3.5" style={{ animationDelay: `${300 + i * 90}ms` }}>
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-inset ring-white/15">
                  <Icon aria-hidden className="h-4 w-4 text-blue-200" />
                </span>
                <span>
                  <span className="block text-sm font-semibold leading-snug">{title}</span>
                  <span className="mt-0.5 block text-[13px] leading-relaxed text-blue-100/70">{body}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="auth-rise text-xs text-blue-200/60" style={{ animationDelay: "570ms" }}>
            SEO and news monitoring by A3 Brands
          </p>
        </aside>
      </div>
    </div>
  );
}
