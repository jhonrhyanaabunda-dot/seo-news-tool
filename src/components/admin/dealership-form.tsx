"use client";

import { useActionState } from "react";
import type { Dealership } from "@/lib/db/schema";
import type { DealershipFormState } from "@/app/actions/dealerships";

type Action = (prev: DealershipFormState, formData: FormData) => Promise<DealershipFormState>;

function Field({ id, label, error, hint, children }: { id: string; label: string; error?: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="label">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Toggle({ name, label, description, defaultChecked }: { name: string; label: string; description: string; defaultChecked: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-slate-200 p-3 hover:bg-slate-50">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600" />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        <span className="block text-xs text-slate-500">{description}</span>
      </span>
    </label>
  );
}

export function DealershipForm({
  action,
  dealership,
  defaultInterval,
  regions,
  defaultRegionLabel,
}: {
  action: Action;
  dealership?: Dealership;
  defaultInterval: number;
  regions: Array<{ id: string; label: string }>;
  defaultRegionLabel: string;
}) {
  const [state, formAction, pending] = useActionState<DealershipFormState, FormData>(action, undefined);
  const e = state?.errors ?? {};
  const d = dealership;
  // After a failed submit, show what was typed (React resets forms to their default values).
  const sv = state?.values;
  const val = (k: string, fallback: string | number | null | undefined) => (sv ? sv[k] : (fallback ?? "")) as string | number;
  const chk = (k: string, fallback: boolean) => (sv ? sv[k] === "on" : fallback);
  const aria = (k: string) => (e[k as keyof typeof e] ? { "aria-invalid": true as const, "aria-describedby": `${k}-error` } : {});
  return (
    <form action={formAction} className="space-y-6" noValidate>
      {d && <input type="hidden" name="id" value={d.id} />}
      {e.form && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-inset ring-red-200">
          {e.form}
        </div>
      )}
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Dealership</legend>
        <Field id="name" label="Dealership name *" error={e.name}>
          <input id="name" name="name" required defaultValue={val("name", d?.name)} className="input" {...aria("name")} />
        </Field>
        <Field id="websiteUrl" label="Website URL *" error={e.websiteUrl} hint="The dealership's official public homepage, e.g. https://www.yourdealership.com">
          <input id="websiteUrl" name="websiteUrl" type="url" inputMode="url" required defaultValue={val("websiteUrl", d?.websiteUrl)} placeholder="https://" className="input" {...aria("websiteUrl")} />
        </Field>
        <Field id="brand" label="Brand *" error={e.brand} hint="Manufacturer, e.g. BMW, Toyota">
          <input id="brand" name="brand" required defaultValue={val("brand", d?.brand)} className="input" {...aria("brand")} />
        </Field>
        <Field id="dealerGroup" label="Dealer group" error={e.dealerGroup} hint="Used for news monitoring">
          <input id="dealerGroup" name="dealerGroup" defaultValue={val("dealerGroup", d?.dealerGroup)} className="input" />
        </Field>
        <Field id="city" label="City" error={e.city} hint="Used for local news">
          <input id="city" name="city" defaultValue={val("city", d?.city)} className="input" />
        </Field>
        <Field id="state" label="State" error={e.state}>
          <input id="state" name="state" defaultValue={val("state", d?.state)} className="input" />
        </Field>
        <Field id="websitePlatform" label="Website platform" error={e.websitePlatform} hint={d?.detectedPlatform ? `Detected: ${d.detectedPlatform}. Leave blank to use the detected platform.` : "e.g. Dealer Inspire, Dealer.com, DealerOn. Detected automatically when left blank."}>
          <input id="websitePlatform" name="websitePlatform" defaultValue={val("websitePlatform", d?.websitePlatform)} className="input" />
        </Field>
        <Field id="sitemapUrl" label="Sitemap URL" error={e.sitemapUrl} hint="Only if the sitemap is not at /sitemap.xml or listed in robots.txt. Crawls start from the sitemap.">
          <input id="sitemapUrl" name="sitemapUrl" type="url" inputMode="url" defaultValue={val("sitemapUrl", d?.sitemapUrl)} placeholder="https://" className="input" {...aria("sitemapUrl")} />
        </Field>
      </fieldset>

      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-slate-900">Notifications</legend>
        <Field id="notificationEmails" label="Notification email addresses" error={e.notificationEmails} hint="One per line or comma-separated. These people receive digests and alerts for this dealership.">
          <textarea id="notificationEmails" name="notificationEmails" rows={3} defaultValue={val("notificationEmails", (d?.notificationEmails ?? []).join("\n"))} className="input" {...aria("notificationEmails")} />
        </Field>
      </fieldset>

      <fieldset className="grid gap-3 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Monitoring</legend>
        <Toggle name="seoEnabled" label="SEO monitoring" description="Crawl the website and track SEO issues and score." defaultChecked={chk("seoEnabled", d?.seoEnabled ?? true)} />
        <Toggle name="newsEnabled" label="News monitoring" description="Track news about the dealership, group, brand and local market." defaultChecked={chk("newsEnabled", d?.newsEnabled ?? true)} />
        <Toggle name="instantAlertsEnabled" label="Immediate critical alerts" description="Email right away when the site goes down or new critical issues appear." defaultChecked={chk("instantAlertsEnabled", d?.instantAlertsEnabled ?? true)} />
        <Toggle name="isActive" label="Active" description="Inactive dealerships are kept for history but not scanned or emailed." defaultChecked={chk("isActive", d?.isActive ?? true)} />
      </fieldset>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-slate-900">Advanced</legend>
        <Field id="scanIntervalHours" label="Scan schedule" error={e.scanIntervalHours}>
          <select id="scanIntervalHours" name="scanIntervalHours" defaultValue={val("scanIntervalHours", d?.scanIntervalHours)} className="input">
            <option value="">Use global setting (every {defaultInterval}h)</option>
            <option value="6">Every 6 hours</option>
            <option value="12">Every 12 hours</option>
            <option value="24">Daily</option>
            <option value="168">Weekly</option>
          </select>
        </Field>
        <Field id="preferredRegion" label="Preferred crawler region" error={e.preferredRegion} hint="Where this website is scanned from. Leave on default unless the site needs a specific region.">
          <select id="preferredRegion" name="preferredRegion" defaultValue={val("preferredRegion", d?.preferredRegion)} className="input">
            <option value="">Default ({defaultRegionLabel})</option>
            {regions.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          id="renderMode"
          label="Page fetching"
          error={e.renderMode}
          hint="Some websites only serve pages to a real browser. “Automatic” uses one only after a plain request is refused; the crawler always identifies itself honestly and honours robots.txt."
        >
          <select id="renderMode" name="renderMode" defaultValue={val("renderMode", d?.renderMode ?? "auto")} className="input">
            <option value="auto">Automatic (use a browser only if refused)</option>
            <option value="never">Plain requests only</option>
            <option value="always">Always use a real browser</option>
          </select>
        </Field>
        <Field id="maxPages" label="Max pages per scan" error={e.maxPages} hint="Leave blank for the default. Key pages are crawled first (homepage, inventory, service, parts, finance, about, contact, blog); inventory is sampled.">
          <input id="maxPages" name="maxPages" type="number" min={5} max={500} defaultValue={val("maxPages", d?.maxPages)} className="input" {...aria("maxPages")} />
        </Field>
        <div className="sm:col-span-2">
          <Field id="notes" label="Internal notes" error={e.notes}>
            <textarea id="notes" name="notes" rows={2} defaultValue={val("notes", d?.notes)} className="input" />
          </Field>
        </div>
      </fieldset>

      <div className="flex justify-end gap-2 border-t border-slate-100 pt-4">
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? "Saving…" : d ? "Save changes" : "Add dealership"}
        </button>
      </div>
    </form>
  );
}
