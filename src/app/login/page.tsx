import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <div className="auth-bg flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="auth-mark flex h-12 w-12 items-center justify-center rounded-xl text-base font-bold tracking-tight text-white">A3</div>
          <div className="mt-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-blue-300/90">A3 Brands</div>
          <h1 className="mt-1.5 text-[26px] font-semibold leading-tight text-white">SEO &amp; News Monitor</h1>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-blue-100/70">Every dealership website, checked daily.</p>
        </div>
        <div className="auth-card rounded-2xl bg-white p-7 sm:p-8">
          <div className="mb-6">
            <h2 className="text-lg font-semibold text-slate-900">Welcome back</h2>
            <p className="mt-1 text-sm text-slate-500">Scores, issues and news for every dealership you track.</p>
          </div>
          <LoginForm next={next} />
        </div>
        <p className="mt-5 text-center text-xs leading-relaxed text-blue-200/60">Accounts are created by an administrator. Ask yours to reset a forgotten password.</p>
      </div>
    </div>
  );
}
