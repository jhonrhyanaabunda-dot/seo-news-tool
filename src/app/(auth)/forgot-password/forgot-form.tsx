"use client";

import Link from "next/link";
import { useActionState } from "react";
import { AlertCircle, ArrowLeft, Loader2, MailCheck } from "lucide-react";
import { requestPasswordResetAction, type ForgotState } from "@/app/actions/password-reset";

export function ForgotForm() {
  const [state, action, pending] = useActionState<ForgotState, FormData>(requestPasswordResetAction, undefined);

  if (state?.sent) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-lg bg-emerald-50 px-3.5 py-3 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
          <MailCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            If {state.email} has an account, a reset link is on its way. It works once and expires in an hour. Check your spam folder if it does not arrive within a few minutes.
          </span>
        </div>
        <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline">
          <ArrowLeft aria-hidden className="h-4 w-4" /> Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-4" noValidate>
      {state?.error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800 ring-1 ring-inset ring-red-200">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}
      <div>
        <label htmlFor="email" className="auth-label">
          Email
        </label>
        <input id="email" name="email" type="email" autoComplete="username" required autoFocus placeholder="you@a3brands.com" className="auth-input" defaultValue={state?.email ?? ""} />
      </div>
      <button type="submit" className="btn-primary h-11 w-full rounded-lg text-[15px] font-semibold" disabled={pending}>
        {pending ? (
          <>
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Sending…
          </>
        ) : (
          "Email me a reset link"
        )}
      </button>
      <Link href="/login" className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900">
        <ArrowLeft aria-hidden className="h-4 w-4" /> Back to sign in
      </Link>
    </form>
  );
}
