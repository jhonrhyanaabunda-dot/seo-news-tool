"use client";

import { useActionState, useEffect, useRef } from "react";
import { addKeywordAction, type KeywordState } from "@/app/actions/dealerships";

export function KeywordForm({ dealershipId }: { dealershipId: number }) {
  const [state, action, pending] = useActionState<KeywordState, FormData>(addKeywordAction, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="flex flex-wrap items-start gap-2">
      <input type="hidden" name="id" value={dealershipId} />
      <div className="flex-1">
        <label htmlFor="keyword" className="sr-only">
          New keyword
        </label>
        <input id="keyword" name="keyword" placeholder="e.g. Hendrick Automotive, Emerald Coast BMW" className="input" aria-describedby={state?.error ? "keyword-error" : undefined} />
        {state?.error && (
          <p id="keyword-error" role="alert" className="field-error">
            {state.error}
          </p>
        )}
      </div>
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "Adding…" : "Add keyword"}
      </button>
    </form>
  );
}
