"use client";

import { useActionState, useState } from "react";
import { AlertCircle, KeyRound, Loader2 } from "lucide-react";
import { cancelMfaAction, verifyMfaAction, type MfaLoginState } from "@/lib/auth/actions";

export function VerifyForm() {
  const [state, action, pending] = useActionState<MfaLoginState, FormData>(verifyMfaAction, undefined);
  const [recovery, setRecovery] = useState(false);
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-4" noValidate>
        {state?.error && (
          <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800 ring-1 ring-inset ring-red-200">
            <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{state.error}</span>
          </div>
        )}
        <div>
          <label htmlFor="code" className="auth-label">
            {recovery ? "Recovery code" : "Authentication code"}
          </label>
          <div className="relative">
            <KeyRound aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            {recovery ? (
              <input key="recovery" id="code" name="code" autoComplete="off" autoCapitalize="characters" spellCheck={false} required autoFocus placeholder="XXXXX-XXXXX" className="auth-input pl-10 font-mono tracking-wider" />
            ) : (
              <input key="totp" id="code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required autoFocus placeholder="123456" className="auth-input pl-10 font-mono tracking-[0.3em]" />
            )}
          </div>
          <p className="mt-1.5 text-xs text-slate-500">
            {recovery ? "Each recovery code works once. After signing in, consider generating new ones on your Account page." : "Codes change every 30 seconds."}
          </p>
        </div>
        <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={pending}>
          {pending ? (
            <>
              <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Verifying…
            </>
          ) : (
            "Verify and sign in"
          )}
        </button>
      </form>
      <div className="flex items-center justify-between gap-3 text-sm">
        <button type="button" onClick={() => setRecovery((v) => !v)} className="font-medium text-brand-700 hover:underline">
          {recovery ? "Use an authenticator code" : "Use a recovery code"}
        </button>
        <form action={cancelMfaAction}>
          <button type="submit" className="font-medium text-slate-500 hover:text-slate-900">
            Start over
          </button>
        </form>
      </div>
    </div>
  );
}
