import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <div className="flex min-h-screen items-center justify-center bg-brand-900 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center text-white">
          <div className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-300">A3 Brands</div>
          <h1 className="mt-1 text-2xl font-semibold">SEO &amp; News Monitor</h1>
        </div>
        <div className="rounded-lg bg-white p-6 shadow-xl">
          <LoginForm next={next} />
        </div>
        <p className="mt-4 text-center text-xs text-blue-200/80">Accounts are created by an administrator.</p>
      </div>
    </div>
  );
}
