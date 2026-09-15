"use client";

import { useActionState, useEffect, useRef } from "react";
import { addNewsSourceAction, type NewsSourceState } from "@/app/actions/news-sources";

export function NewsSourceForm({ dealershipId, brand }: { dealershipId: number; brand: string }) {
  const [state, action, pending] = useActionState<NewsSourceState, FormData>(addNewsSourceAction, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="space-y-2">
      <input type="hidden" name="id" value={dealershipId} />
      <div>
        <label htmlFor="sourceType" className="label">
          Source type
        </label>
        <select id="sourceType" name="sourceType" className="input" defaultValue="dealership">
          <option value="dealership">Official dealership news / blog feed</option>
          <option value="manufacturer">Manufacturer newsroom feed</option>
          <option value="rss">Other publisher feed (must mention the dealership)</option>
        </select>
      </div>
      <div>
        <label htmlFor="sourceLabel" className="label">
          Name
        </label>
        <input id="sourceLabel" name="label" placeholder="e.g. Dealership blog" className="input" />
      </div>
      <div>
        <label htmlFor="sourceUrl" className="label">
          RSS / Atom feed URL
        </label>
        <input id="sourceUrl" name="url" type="url" inputMode="url" placeholder="https://" className="input" />
      </div>
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" name="allBrandDealerships" className="mt-1" />
        <span>Manufacturer feeds only: use for every {brand} dealership</span>
      </label>
      {state?.error && (
        <p role="alert" className="field-error">
          {state.error}
        </p>
      )}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "Adding…" : "Add feed"}
      </button>
    </form>
  );
}
