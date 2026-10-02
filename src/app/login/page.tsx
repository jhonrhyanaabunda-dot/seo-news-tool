import type { Metadata } from "next";
import Image from "next/image";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <div className="auth-bg flex min-h-screen items-center justify-center p-4 sm:p-6">
      <div className="auth-card grid w-full max-w-4xl overflow-hidden rounded-2xl md:grid-cols-[1.05fr_1fr]">
        <aside className="auth-panel flex flex-col justify-between gap-10 px-8 py-7 text-white sm:p-10">
          <div>
            <div className="inline-flex rounded-xl bg-white p-3 shadow-lg">
              <Image src="/a3brands-logo.png" alt="A3 Brands" width={1388} height={879} priority className="h-12 w-auto" />
            </div>
            <h1 className="mt-5 text-xl font-semibold leading-tight sm:mt-7 sm:text-2xl">Your SEO monitoring portal</h1>
            {/* On phones the form matters more than the pitch: keep the fields above the fold. */}
            <p className="mt-3 hidden max-w-sm text-[15px] leading-relaxed text-blue-100/75 sm:block">
              Every dealership website checked daily: scores, the issues worth fixing, and the news written about each store.
            </p>
          </div>
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
