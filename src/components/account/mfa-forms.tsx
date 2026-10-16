"use client";

import { useActionState } from "react";
import { useRouter } from "next/navigation";
import { confirmMfaEnrollmentAction, disableMfaAction, regenerateRecoveryCodesAction, type MfaFormState } from "@/app/actions/mfa";

function FormError({ state }: { state: MfaFormState }) {
  if (!state?.error) return null;
  return (
    <p role="alert" className="field-error">
      {state.error}
    </p>
  );
}

/**
 * The one moment recovery codes are visible. They are not stored anywhere
 * readable, so the page only moves on when the person says they have them.
 */
function RecoveryCodes({ ok, codes }: { ok?: string; codes: string[] }) {
  const router = useRouter();
  return (
    <div role="status" className="space-y-3 rounded-md bg-emerald-50 p-4 text-sm text-emerald-950 ring-1 ring-inset ring-emerald-200">
      {ok && <p className="font-medium">{ok}</p>}
      <p>
        Save these recovery codes somewhere safe, such as a password manager. Each one signs you in once if you lose your phone. <strong>They will not be shown again.</strong>
      </p>
      <ul className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-md bg-white p-3 font-mono text-sm text-slate-900 ring-1 ring-inset ring-emerald-200 sm:w-max">
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard?.writeText(codes.join("\n")).catch(() => {})}>
          Copy codes
        </button>
        <button type="button" className="btn-primary btn-sm" onClick={() => router.refresh()}>
          I have saved them
        </button>
      </div>
    </div>
  );
}

export function ConfirmMfaForm() {
  const [state, action, pending] = useActionState<MfaFormState, FormData>(confirmMfaEnrollmentAction, undefined);
  if (state?.recoveryCodes) return <RecoveryCodes ok={state.ok} codes={state.recoveryCodes} />;
  return (
    <form action={action} className="max-w-xs space-y-2">
      <label htmlFor="mfa-confirm-code" className="label">
        Code from the app
      </label>
      <input id="mfa-confirm-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required placeholder="123456" className="input font-mono tracking-[0.3em]" />
      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? "Checking…" : "Turn on two-factor"}
      </button>
      <FormError state={state} />
    </form>
  );
}

export function DisableMfaForm() {
  const [state, action, pending] = useActionState<MfaFormState, FormData>(disableMfaAction, undefined);
  return (
    <form action={action} className="max-w-xs space-y-2">
      <label htmlFor="mfa-disable" className="label">
        Current code or your password
      </label>
      <input id="mfa-disable" name="credential" type="password" autoComplete="off" required className="input" />
      <button type="submit" className="btn-danger" disabled={pending}>
        {pending ? "Turning off…" : "Turn off two-factor"}
      </button>
      <FormError state={state} />
      {state?.ok && <p role="status" className="text-sm text-emerald-700">{state.ok}</p>}
    </form>
  );
}

export function RegenerateCodesForm() {
  const [state, action, pending] = useActionState<MfaFormState, FormData>(regenerateRecoveryCodesAction, undefined);
  if (state?.recoveryCodes) return <RecoveryCodes ok={state.ok} codes={state.recoveryCodes} />;
  return (
    <form action={action} className="max-w-xs space-y-2">
      <label htmlFor="mfa-regen-code" className="label">
        Current code from the app
      </label>
      <input id="mfa-regen-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]*" maxLength={7} required placeholder="123456" className="input font-mono tracking-[0.3em]" />
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "Generating…" : "Generate new recovery codes"}
      </button>
      <FormError state={state} />
    </form>
  );
}
