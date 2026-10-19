"use client";

import { useActionState } from "react";
import { confirmTwoFactorAction, disableTwoFactorAction, regenerateRecoveryCodesAction, type TwoFactorState } from "@/app/actions/two-factor";

function Message({ state }: { state: TwoFactorState }) {
  if (!state?.error) return null;
  return (
    <p role="alert" className="field-error">
      {state.error}
    </p>
  );
}

/** Shown once, straight after they are created; only hashes are stored. */
function RecoveryCodes({ codes, note }: { codes: string[]; note: string }) {
  return (
    <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-4 text-sm text-emerald-950">
      <p className="font-medium">{note}</p>
      <p className="mt-1 text-emerald-900">
        Save these recovery codes somewhere safe, such as a password manager. Each one signs you in once if you lose your phone. They will not be shown again.
      </p>
      <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[15px] tracking-wide sm:grid-cols-5">
        {codes.map((c) => (
          <li key={c} className="select-all">
            {c}
          </li>
        ))}
      </ul>
      {/* A full reload shows the updated status; the codes are not shown again. */}
      <a href="/account#two-factor" className="btn mt-4">
        I have saved them
      </a>
    </div>
  );
}

const codeInput = "input w-40 text-center font-mono tracking-[0.25em]";

export function ConfirmSetupForm() {
  const [state, action, pending] = useActionState<TwoFactorState, FormData>(confirmTwoFactorAction, undefined);
  if (state?.codes) return <RecoveryCodes codes={state.codes} note={state.ok ?? "Two-factor login is on."} />;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="setup-code" className="label">
          Code from the app
        </label>
        <input id="setup-code" name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} placeholder="123 456" className={codeInput} />
      </div>
      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? "Checking…" : "Turn on two-factor login"}
      </button>
      <div className="w-full">
        <Message state={state} />
      </div>
    </form>
  );
}

export function RegenerateCodesForm() {
  const [state, action, pending] = useActionState<TwoFactorState, FormData>(regenerateRecoveryCodesAction, undefined);
  if (state?.codes) return <RecoveryCodes codes={state.codes} note={state.ok ?? "New recovery codes."} />;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="regen-code" className="label">
          Current app code
        </label>
        <input id="regen-code" name="code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} className={codeInput} />
      </div>
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "Creating…" : "Create new recovery codes"}
      </button>
      <div className="w-full">
        <Message state={state} />
      </div>
    </form>
  );
}

export function DisableForm() {
  const [state, action, pending] = useActionState<TwoFactorState, FormData>(disableTwoFactorAction, undefined);
  if (state?.ok) return <p className="text-sm text-slate-700">{state.ok}</p>;
  return (
    <form action={action} className="flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="off-password" className="label">
          Password
        </label>
        <input id="off-password" name="password" type="password" required autoComplete="current-password" className="input w-56" />
      </div>
      <div>
        <label htmlFor="off-code" className="label">
          App or recovery code
        </label>
        <input id="off-code" name="code" required autoComplete="one-time-code" maxLength={20} className={codeInput} />
      </div>
      <button type="submit" className="btn-danger" disabled={pending}>
        {pending ? "Turning off…" : "Turn off"}
      </button>
      <div className="w-full">
        <Message state={state} />
      </div>
    </form>
  );
}
