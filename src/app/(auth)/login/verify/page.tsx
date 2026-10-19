import type { Metadata } from "next";
import Link from "next/link";
import { cookies } from "next/headers";
import { env } from "@/lib/env";
import { SECOND_FACTOR_COOKIE, readTicket } from "@/lib/auth/totp";
import { VerifyForm } from "./verify-form";

export const metadata: Metadata = { title: "Two-factor sign-in" };
export const dynamic = "force-dynamic";

export default async function VerifyPage() {
  const ticket = readTicket((await cookies()).get(SECOND_FACTOR_COOKIE)?.value, env().AUTH_SECRET);
  return (
    <>
      <div className="text-center">
        <h2 className="text-2xl font-semibold tracking-tight text-slate-900">Enter your code</h2>
        <p className="mt-1.5 text-sm text-slate-500">
          {ticket ? "Open your authenticator app and enter the 6-digit code for A3 SEO Monitor." : "This sign-in has expired after five minutes."}
        </p>
      </div>
      <div className="mt-7">
        {ticket ? (
          <VerifyForm />
        ) : (
          <Link href="/login" className="btn-primary h-11 w-full text-[15px]">
            Sign in again
          </Link>
        )}
      </div>
    </>
  );
}
