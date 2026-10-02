"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { completePasswordResetAction, type ResetState } from "@/app/actions/password-reset";

export function ResetForm({ token }: { token: string }) {
  const [state, action, pending] = useActionState<ResetState, FormData>(completePasswordResetAction, undefined);
  const [show, setShow] = useState(false);

  if (state?.ok) {
    return (
      <div className="space-y-4">
        <div className="flex items-start gap-2.5 rounded-lg bg-emerald-50 px-3.5 py-3 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
          <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Your password has been changed, and any other devices were signed out.</span>
        </div>
        <Link href="/login" className="btn-primary inline-flex h-11 w-full items-center justify-center rounded-lg text-[15px] font-semibold">
          Sign in
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
      <input type="hidden" name="token" value={token} />
      <div>
        <label htmlFor="password" className="auth-label">
          New password
        </label>
        <div className="relative">
          <input id="password" name="password" type={show ? "text" : "password"} autoComplete="new-password" required minLength={10} className="auth-input pr-20" aria-describedby="pw-hint" />
          <button
            type="button"
            onClick={() => setShow((v) => !v)}
            aria-pressed={show}
            className="absolute inset-y-0 right-0 px-4 text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:text-slate-800"
          >
            {show ? "Hide" : "Show"}
            <span className="sr-only"> password</span>
          </button>
        </div>
        <p id="pw-hint" className="field-hint">
          At least 10 characters, including letters and numbers.
        </p>
      </div>
      <div>
        <label htmlFor="confirm" className="auth-label">
          Confirm new password
        </label>
        <input id="confirm" name="confirm" type={show ? "text" : "password"} autoComplete="new-password" required className="auth-input" />
      </div>
      <button type="submit" className="btn-primary h-11 w-full rounded-lg text-[15px] font-semibold" disabled={pending}>
        {pending ? (
          <>
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Saving…
          </>
        ) : (
          "Save new password"
        )}
      </button>
    </form>
  );
}
