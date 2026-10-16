import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; expired?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next, expired } = await searchParams;
  return (
    <>
      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h2>
        <p className="mt-1.5 text-sm text-slate-500">Use your A3 SEO Monitor account.</p>
      </div>
      {expired && (
        <p role="status" className="mt-5 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 ring-1 ring-inset ring-amber-200">
          Your sign-in timed out before the code was entered. Please sign in again.
        </p>
      )}
      <div className="mt-7">
        <LoginForm next={next} />
      </div>
    </>
  );
}
