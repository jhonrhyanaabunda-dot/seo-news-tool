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
      <div className="auth-card grid w-full max-w-4xl overflow-hidden rounded-2xl md:grid-cols-[1.05fr_1fr]">
        <aside className="auth-panel flex flex-col gap-8 px-8 py-7 text-white sm:p-10">
          <div>
            <div className="inline-flex rounded-xl bg-white p-3 shadow-lg">
              <Image src="/a3brands-logo.png" alt="A3 Brands" width={1388} height={879} priority className="h-11 w-auto" />
            </div>
            <h1 className="mt-5 text-xl font-semibold leading-tight sm:mt-6 sm:text-[26px]">Your SEO monitoring portal</h1>
          </div>

          {/* On phones the form matters more than the pitch: keep the fields above the fold. */}
          <ul className="hidden flex-1 space-y-5 sm:block">
            {PROOF.map(({ icon: Icon, title, body }) => (
              <li key={title} className="flex gap-3.5">
                <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-inset ring-white/15">
                  <Icon aria-hidden className="h-[18px] w-[18px] text-blue-200" />
                </span>
                <span>
                  <span className="block text-[15px] font-semibold leading-snug">{title}</span>
                  <span className="mt-1 block text-sm leading-relaxed text-blue-100/70">{body}</span>
                </span>
              </li>
            ))}
          </ul>

          <p className="hidden text-sm text-blue-200/60 sm:block">SEO and news monitoring by A3 Brands</p>
        </aside>
        <div className="bg-white p-8 sm:p-10">
          <h2 className="text-2xl font-semibold text-slate-900">Sign in</h2>
          <p className="mt-1.5 text-sm text-slate-500">Enter your email and password to continue.</p>
          <div className="mt-7">
            <LoginForm next={next} />
          </div>
        </div>
      </div>
    </div>
  );
}
