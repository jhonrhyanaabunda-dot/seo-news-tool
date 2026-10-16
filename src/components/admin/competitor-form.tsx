"use client";

import { useActionState, useEffect, useRef } from "react";
import { addCompetitorAction, type CompetitorFormState } from "@/app/actions/integrations";

export function CompetitorForm({ dealershipId }: { dealershipId: number }) {
  const [state, action, pending] = useActionState<CompetitorFormState, FormData>(addCompetitorAction, undefined);
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) ref.current?.reset();
  }, [state]);
  const e = state?.errors ?? {};
  return (
    <form ref={ref} action={action} className="space-y-2" noValidate>
      <input type="hidden" name="id" value={dealershipId} />
      {e.form && (
        <p role="alert" className="field-error">
          {e.form}
        </p>
      )}
      <div>
        <label htmlFor="competitor-name" className="label">
          Competitor name
        </label>
        <input id="competitor-name" name="name" className="input" placeholder="e.g. Coastal Toyota" aria-describedby={e.name ? "competitor-name-error" : undefined} aria-invalid={e.name ? true : undefined} />
        {e.name && (
          <p id="competitor-name-error" role="alert" className="field-error">
            {e.name}
          </p>
        )}
      </div>
      <div>
        <label htmlFor="competitor-url" className="label">
          Website
        </label>
        <input id="competitor-url" name="websiteUrl" type="url" inputMode="url" className="input" placeholder="https://" aria-describedby={e.websiteUrl ? "competitor-url-error" : undefined} aria-invalid={e.websiteUrl ? true : undefined} />
        {e.websiteUrl && (
          <p id="competitor-url-error" role="alert" className="field-error">
            {e.websiteUrl}
          </p>
        )}
      </div>
      <button type="submit" className="btn" disabled={pending}>
        {pending ? "Adding…" : "Add competitor"}
      </button>
    </form>
  );
}
