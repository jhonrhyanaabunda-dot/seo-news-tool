"use client";

import { useActionState, useEffect, useRef } from "react";
import { addSeoFeedAction, type SeoFeedState } from "@/app/actions/seo-news";

export function SeoFeedForm() {
  const [state, action, pending] = useActionState<SeoFeedState, FormData>(addSeoFeedAction, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  return (
    <form ref={ref} action={action} className="space-y-2">
      <div>
        <label htmlFor="seoFeedLabel" className="label">
          Publication name
        </label>
        <input id="seoFeedLabel" name="label" placeholder="e.g. Search Engine Land" className="input" />
      </div>
      <div>
        <label htmlFor="seoFeedUrl" className="label">
          RSS / Atom feed URL
        </label>
        <input id="seoFeedUrl" name="url" type="url" inputMode="url" placeholder="https://" className="input" />
      </div>
      <label className="flex items-start gap-2 text-sm text-slate-700">
        <input type="checkbox" name="official" className="mt-1" />
        <span>Official search-engine source (ranks first in the newsletter)</span>
      </label>
      {state?.error && (
        <p role="alert" className="field-error">
          {state.error}
        </p>
      )}
      {state?.ok && (
        <p role="status" className="text-sm text-emerald-700">
          Feed added. Its latest articles will appear shortly.
        </p>
      )}
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "Checking feed…" : "Add feed"}
      </button>
    </form>
  );
}
