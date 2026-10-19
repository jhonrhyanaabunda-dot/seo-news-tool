"use client";

import { useActionState, useState } from "react";
import Link from "next/link";
import { AlertCircle, Loader2 } from "lucide-react";
import { verifySecondFactorAction, type VerifyState } from "@/lib/auth/actions";

export function VerifyForm() {
  const [state, action, pending] = useActionState<VerifyState, FormData>(verifySecondFactorAction, undefined);
  const [recovery, setRecovery] = useState(false);
  return (
    <form action={action} className="space-y-4">
      {state?.error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-800">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}
      <div>
        <label htmlFor="code" className="auth-label">
          {recovery ? "Recovery code" : "6-digit code"}
        </label>
        <input
          id="code"
          name="code"
          required
          autoFocus
          autoComplete="one-time-code"
          inputMode={recovery ? "text" : "numeric"}
          pattern={recovery ? undefined : "[0-9 ]{6,7}"}
          maxLength={recovery ? 20 : 7}
          placeholder={recovery ? "xxxx-xxxx" : "123 456"}
          className="auth-input text-center font-mono text-lg tracking-[0.3em]"
          key={recovery ? "recovery" : "totp"}
        />
      </div>
      <button type="submit" className="btn-primary h-11 w-full text-[15px]" disabled={pending}>
        {pending ? (
          <>
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Checking…
          </>
        ) : (
          "Verify"
        )}
      </button>
      <div className="flex items-center justify-between text-sm">
        <button type="button" onClick={() => setRecovery((v) => !v)} className="font-medium text-brand-700 hover:underline">
          {recovery ? "Use the app code instead" : "Use a recovery code"}
        </button>
        <Link href="/login" className="text-slate-500 hover:text-slate-800">
          Back to sign in
        </Link>
      </div>
    </form>
  );
}
