import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { readPendingMfa } from "@/lib/auth/mfa";
import { getCurrentUser } from "@/lib/auth/session";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Two-factor sign-in" };

/**
 * The code step of sign-in. Reachable only with a valid pending cookie from a
 * correct password in the last five minutes; anything else starts over.
 */
export default async function VerifyPage() {
  if (await getCurrentUser()) redirect("/");
  if (!(await readPendingMfa())) redirect("/login?expired=1");
  return (
    <>
      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Two-factor sign-in</h2>
        <p className="mt-1.5 text-sm text-slate-500">Enter the 6-digit code from your authenticator app.</p>
      </div>
      <div className="mt-7">
        <VerifyForm />
      </div>
    </>
  );
}
