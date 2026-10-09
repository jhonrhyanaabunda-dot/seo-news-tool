"use client";

import { useActionState } from "react";
import { changeOwnPasswordAction, createUserAction, editUserAction, resetPasswordAction, setUserDealershipsAction, type UserFormState } from "@/app/actions/users";

function Result({ state }: { state: UserFormState }) {
  if (!state) return null;
  if (state.error)
    return (
      <p role="alert" className="field-error">
        {state.error}
      </p>
    );
  return (
    <div role="status" className="mt-2 rounded-md bg-emerald-50 p-3 text-sm text-emerald-900 ring-1 ring-inset ring-emerald-200">
      {state.ok}
      {state.tempPassword && (
        <div className="mt-1">
          Temporary password: <code className="select-all rounded bg-white px-1.5 py-0.5 font-mono">{state.tempPassword}</code>
        </div>
      )}
    </div>
  );
}

export function CreateUserForm() {
  const [state, action, pending] = useActionState<UserFormState, FormData>(createUserAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <div>
        <label htmlFor="u-name" className="label">
          Name
        </label>
        <input id="u-name" name="name" required className="input" />
      </div>
      <div>
        <label htmlFor="u-email" className="label">
          Email
        </label>
        <input id="u-email" name="email" type="email" required className="input" />
      </div>
      <div>
        <label htmlFor="u-role" className="label">
          Role
        </label>
        <select id="u-role" name="role" defaultValue="viewer" className="input">
          <option value="viewer">Viewer — whole portfolio, read-only</option>
          <option value="admin">Administrator — also manages dealerships, settings and users</option>
          <option value="client">Dealership — only the dealerships you assign</option>
        </select>
        <p className="mt-1 text-xs text-slate-500">A dealership account sees nothing until you assign it at least one dealership.</p>
      </div>
      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? "Creating…" : "Create user"}
      </button>
      <Result state={state} />
    </form>
  );
}

export function EditUserForm({ user }: { user: { id: number; name: string; email: string } }) {
  const [state, action, pending] = useActionState<UserFormState, FormData>(editUserAction, undefined);
  return (
    <details className="mt-1 text-sm">
      <summary className="inline cursor-pointer text-xs font-medium text-brand-700 hover:underline">Edit</summary>
      <form action={action} className="mt-2 max-w-xs space-y-2">
        <input type="hidden" name="userId" value={user.id} />
        <div>
          <label htmlFor={`edit-name-${user.id}`} className="label">
            Name
          </label>
          <input id={`edit-name-${user.id}`} name="name" defaultValue={user.name} required minLength={2} className="input" />
        </div>
        <div>
          <label htmlFor={`edit-email-${user.id}`} className="label">
            Email
          </label>
          <input id={`edit-email-${user.id}`} name="email" type="email" defaultValue={user.email} required className="input" />
        </div>
        <button type="submit" className="btn btn-sm" disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </button>
        <Result state={state} />
      </form>
    </details>
  );
}

export function ResetPasswordForm({ userId }: { userId: number }) {
  const [state, action, pending] = useActionState<UserFormState, FormData>(resetPasswordAction, undefined);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="userId" value={userId} />
      <button type="submit" className="btn btn-sm" disabled={pending}>
        {pending ? "Resetting…" : "Reset password"}
      </button>
      <Result state={state} />
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action, pending] = useActionState<UserFormState, FormData>(changeOwnPasswordAction, undefined);
  return (
    <form action={action} className="max-w-sm space-y-3">
      <div>
        <label htmlFor="current" className="label">
          Current password
        </label>
        <input id="current" name="current" type="password" autoComplete="current-password" required className="input" />
      </div>
      <div>
        <label htmlFor="next" className="label">
          New password
        </label>
        <input id="next" name="next" type="password" autoComplete="new-password" required minLength={10} className="input" aria-describedby="next-hint" />
        <p id="next-hint" className="field-hint">
          At least 10 characters, including letters and numbers.
        </p>
      </div>
      <div>
        <label htmlFor="confirm" className="label">
          Confirm new password
        </label>
        <input id="confirm" name="confirm" type="password" autoComplete="new-password" required className="input" />
      </div>
      <button type="submit" className="btn-primary" disabled={pending}>
        {pending ? "Saving…" : "Change password"}
      </button>
      <Result state={state} />
    </form>
  );
}

/**
 * Dealership access for one client account. Shown collapsed so the user table
 * stays readable; opening it reveals every dealership with the current
 * assignments ticked.
 */
export function DealershipAccessForm({ userId, email, options, assigned }: { userId: number; email: string; options: Array<{ id: number; name: string }>; assigned: number[] }) {
  const [state, action, pending] = useActionState<UserFormState, FormData>(setUserDealershipsAction, undefined);
  const set = new Set(assigned);
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-brand-700 hover:underline">
        Dealership access ({assigned.length || "none"})
      </summary>
      <form action={action} className="mt-2 space-y-2">
        <input type="hidden" name="userId" value={userId} />
        <fieldset className="max-h-52 space-y-1 overflow-y-auto rounded-md border border-slate-200 p-2">
          <legend className="sr-only">Dealerships {email} may see</legend>
          {options.length === 0 && <p className="text-xs text-slate-500">No dealerships exist yet.</p>}
          {options.map((d) => (
            <label key={d.id} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" name="dealershipId" value={d.id} defaultChecked={set.has(d.id)} className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-100" />
              {d.name}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="btn btn-sm" disabled={pending}>
          {pending ? "Saving…" : "Save access"}
        </button>
        <Result state={state} />
      </form>
    </details>
  );
}
