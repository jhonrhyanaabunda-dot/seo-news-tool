"use client";

import { useActionState, useState } from "react";
import { AlertCircle, Loader2, Lock } from "lucide-react";
import { loginAction, type LoginState } from "@/lib/auth/actions";

export function LoginForm({ next }: { next?: string }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, undefined);
  const [showPassword, setShowPassword] = useState(false);
  return (
    <form action={action} className="space-y-4" noValidate>
      {state?.error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2.5 text-sm text-red-800 ring-1 ring-inset ring-red-200">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{state.error}</span>
        </div>
      )}
      <input type="hidden" name="next" value={next ?? ""} />
      <div className="auth-rise" style={{ animationDelay: "140ms" }}>
        <label htmlFor="email" className="auth-label">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          autoFocus
          placeholder="you@a3brands.com"
          className="auth-input"
          defaultValue={state?.email ?? ""}
          key={state?.email ?? ""}
        />
      </div>
      <div className="auth-rise" style={{ animationDelay: "210ms" }}>
        <label htmlFor="password" className="auth-label">
          Password
        </label>
        <div className="relative">
          <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required className="auth-input pr-20" />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            aria-pressed={showPassword}
            className="absolute inset-y-0 right-0 px-4 text-xs font-semibold uppercase tracking-wide text-slate-500 transition hover:text-slate-800"
          >
            {showPassword ? "Hide" : "Show"}
            <span className="sr-only"> password</span>
          </button>
        </div>
      </div>
      <button type="submit" className="auth-rise btn-primary mt-1 h-11 w-full rounded-lg text-[15px] font-semibold" style={{ animationDelay: "280ms" }} disabled={pending}>
        {pending ? (
          <>
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Signing in…
          </>
        ) : (
          "Sign in"
        )}
      </button>
      <div className="auth-rise space-y-2 pt-1 text-center" style={{ animationDelay: "350ms" }}>
        <p className="flex items-center justify-center gap-1.5 text-xs text-slate-500">
          <Lock aria-hidden className="h-3.5 w-3.5" /> Encrypted connection
        </p>
        <p className="text-xs text-slate-500">Need an account or a password reset? Ask your A3 Brands administrator.</p>
      </div>
    </form>
  );
}
