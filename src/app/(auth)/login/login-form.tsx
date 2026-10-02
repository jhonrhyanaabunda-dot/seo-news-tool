"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { AlertCircle, ArrowRight, Loader2, Lock, Mail } from "lucide-react";
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

      <div className="auth-rise" style={{ animationDelay: "80ms" }}>
        <label htmlFor="email" className="auth-label">
          Email address
        </label>
        <div className="relative">
          <Mail aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            placeholder="Enter your email address"
            className="auth-input pl-10"
            defaultValue={state?.email ?? ""}
            key={state?.email ?? ""}
          />
        </div>
      </div>

      <div className="auth-rise" style={{ animationDelay: "150ms" }}>
        <label htmlFor="password" className="auth-label">
          Password
        </label>
        <div className="relative">
          <Lock aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input id="password" name="password" type={showPassword ? "text" : "password"} autoComplete="current-password" required placeholder="Enter your password" className="auth-input pl-10 pr-20" />
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

      <div className="auth-rise flex items-center justify-between gap-3 pt-0.5" style={{ animationDelay: "210ms" }}>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" name="remember" defaultChecked className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-100" />
          Remember me
        </label>
        <Link href="/forgot-password" className="text-sm font-medium text-brand-700 hover:underline">
          Forgot password?
        </Link>
      </div>

      <button type="submit" className="auth-rise btn-primary group h-11 w-full rounded-lg text-[15px] font-semibold" style={{ animationDelay: "270ms" }} disabled={pending}>
        {pending ? (
          <>
            <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Signing in…
          </>
        ) : (
          <>
            Sign in
            <ArrowRight aria-hidden className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </>
        )}
      </button>

      <p className="auth-rise flex items-center justify-center gap-1.5 pt-1 text-xs text-slate-500" style={{ animationDelay: "330ms" }}>
        <Lock aria-hidden className="h-3.5 w-3.5" /> Your information is secure and private
      </p>
    </form>
  );
}
