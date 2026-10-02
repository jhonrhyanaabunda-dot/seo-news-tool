import type { Metadata } from "next";
import Link from "next/link";
import { ResetForm } from "./reset-form";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <>
      <div className="auth-rise text-center">
        <h2 className="text-[26px] font-bold tracking-tight text-slate-900">Choose a new password</h2>
        <p className="mt-1.5 text-sm text-slate-500">{token ? "Pick something you have not used here before." : "This link is missing its code."}</p>
      </div>
      <div className="mt-7">
        {token ? (
          <ResetForm token={token} />
        ) : (
          <Link href="/forgot-password" className="btn-primary inline-flex h-11 w-full items-center justify-center rounded-lg text-[15px] font-semibold">
            Request a new link
          </Link>
        )}
      </div>
    </>
  );
}
