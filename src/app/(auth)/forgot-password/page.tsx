import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { ForgotForm } from "./forgot-form";

export const metadata: Metadata = { title: "Forgot password" };

export default async function ForgotPasswordPage() {
  if (await getCurrentUser()) redirect("/account");
  return (
    <>
      <div className="auth-rise text-center">
        <h2 className="text-[26px] font-bold tracking-tight text-slate-900">Forgot your password?</h2>
        <p className="mt-1.5 text-sm text-slate-500">Enter your email and we will send you a link to choose a new one.</p>
      </div>
      <div className="mt-7">
        <ForgotForm />
      </div>
    </>
  );
}
