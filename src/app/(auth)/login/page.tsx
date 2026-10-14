import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getCurrentUser()) redirect("/");
  const { next } = await searchParams;
  return (
    <>
      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Sign in</h2>
        <p className="mt-1.5 text-sm text-slate-500">Use your A3 SEO Monitor account.</p>
      </div>
      <div className="mt-7">
        <LoginForm next={next} />
      </div>
    </>
  );
}
