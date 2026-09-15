"use client";

import { useActionState } from "react";
import type { AppSettings } from "@/lib/settings";
import { saveSettingsAction, type SettingsState } from "@/app/actions/settings";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const hours = Array.from({ length: 24 }, (_, h) => ({ value: h, label: new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric" }) }));

function Check({ name, label, description, defaultChecked }: { name: string; label: string; description?: string; defaultChecked: boolean }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
      <span>
        <span className="block text-sm font-medium text-slate-800">{label}</span>
        {description && <span className="block text-xs text-slate-500">{description}</span>}
      </span>
    </label>
  );
}

export function SettingsForm({ settings, timezone }: { settings: AppSettings; timezone: string }) {
  const [state, action, pending] = useActionState<SettingsState, FormData>(saveSettingsAction, undefined);
  return (
    <form action={action} className="space-y-8">
      {state?.error && (
        <div role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800 ring-1 ring-inset ring-red-200">
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div role="status" className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-inset ring-emerald-200">
          Settings saved. They apply from the next scheduler run.
        </div>
      )}

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-slate-900">Scan schedule</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="seoIntervalHours" className="label">
              SEO scans
            </label>
            <select id="seoIntervalHours" name="seoIntervalHours" defaultValue={settings.seoIntervalHours} className="input">
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Daily</option>
              <option value={48}>Every 2 days</option>
              <option value={168}>Weekly</option>
            </select>
            <p className="field-hint">Individual dealerships can override this on their edit page.</p>
          </div>
          <div>
            <label htmlFor="newsIntervalHours" className="label">
              News checks
            </label>
            <select id="newsIntervalHours" name="newsIntervalHours" defaultValue={settings.newsIntervalHours} className="input">
              <option value={3}>Every 3 hours</option>
              <option value={6}>Every 6 hours</option>
              <option value={12}>Every 12 hours</option>
              <option value={24}>Daily</option>
            </select>
          </div>
        </div>
        <Check name="schedulerPaused" label="Pause all scheduled scanning" description="Manual “Scan now” requests still work." defaultChecked={settings.schedulerPaused} />
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-slate-900">Email reports</legend>
        <p className="text-sm text-slate-600">Times are in {timezone}. Daily summaries are only sent when something meaningful changed, unless you choose otherwise below.</p>
        <div className="grid gap-4 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <Check name="dailyDigestEnabled" label="Daily summary" defaultChecked={settings.dailyDigestEnabled} />
          </div>
          <div>
            <label htmlFor="dailyDigestHour" className="label">
              Daily send time
            </label>
            <select id="dailyDigestHour" name="dailyDigestHour" defaultValue={settings.dailyDigestHour} className="input">
              {hours.map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <Check name="weeklyDigestEnabled" label="Weekly SEO newsletter" defaultChecked={settings.weeklyDigestEnabled} />
          </div>
          <div>
            <label htmlFor="weeklyDigestWeekday" className="label">
              Weekly send day
            </label>
            <select id="weeklyDigestWeekday" name="weeklyDigestWeekday" defaultValue={settings.weeklyDigestWeekday} className="input">
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="weeklyDigestHour" className="label">
              Weekly send time
            </label>
            <select id="weeklyDigestHour" name="weeklyDigestHour" defaultValue={settings.weeklyDigestHour} className="input">
              {hours.map((h) => (
                <option key={h.value} value={h.value}>
                  {h.label}
                </option>
              ))}
            </select>
          </div>
          <p className="field-hint -mt-2 sm:col-span-3">
            This week’s top stories from leading SEO publications, plus every dealership’s week. Sent every week, even when no dealership changed.
          </p>
        </div>
        <Check name="sendDigestWhenNoChanges" label="Send summaries even when nothing changed" defaultChecked={settings.sendDigestWhenNoChanges} />
        <Check name="instantAlertsEnabled" label="Send immediate alerts for critical problems" description="Website down or new critical SEO issues. Can also be turned off per dealership." defaultChecked={settings.instantAlertsEnabled} />
        <div>
          <label htmlFor="managementRecipients" className="label">
            Management recipients
          </label>
          <textarea id="managementRecipients" name="managementRecipients" rows={3} defaultValue={settings.managementRecipients.join("\n")} className="input" />
          <p className="field-hint">These addresses receive reports, alerts and the weekly newsletter for every dealership, in addition to each dealership’s own contacts.</p>
        </div>
        <div>
          <label htmlFor="newsletterRecipients" className="label">
            Newsletter-only recipients
          </label>
          <textarea id="newsletterRecipients" name="newsletterRecipients" rows={3} defaultValue={settings.newsletterRecipients.join("\n")} className="input" />
          <p className="field-hint">These addresses receive only the weekly SEO newsletter — no daily summaries or alerts. One address per line.</p>
        </div>
      </fieldset>

      <fieldset className="space-y-4">
        <legend className="text-base font-semibold text-slate-900">Change detection & retention</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="scoreChangeThreshold" className="label">
              Significant score change (points)
            </label>
            <input id="scoreChangeThreshold" name="scoreChangeThreshold" type="number" min={1} max={50} defaultValue={settings.scoreChangeThreshold} className="input" />
            <p className="field-hint">Score changes of at least this many points are reported.</p>
          </div>
          <div>
            <label htmlFor="newsAlertMinScore" className="label">
              News relevance threshold (0–100)
            </label>
            <input id="newsAlertMinScore" name="newsAlertMinScore" type="number" min={1} max={100} defaultValue={settings.newsAlertMinScore} className="input" />
            <p className="field-hint">Articles at or above this score count as “new relevant news” in reports.</p>
          </div>
          <div>
            <label htmlFor="newsLookbackDays" className="label">
              News look-back (days)
            </label>
            <input id="newsLookbackDays" name="newsLookbackDays" type="number" min={1} max={90} defaultValue={settings.newsLookbackDays} className="input" />
          </div>
          <div>
            <label htmlFor="retentionDays" className="label">
              Keep history for (days)
            </label>
            <input id="retentionDays" name="retentionDays" type="number" min={14} max={1095} defaultValue={settings.retentionDays} className="input" />
            <p className="field-hint">Score history and reports older than this are deleted. Page-level details are kept for the 10 most recent scans.</p>
          </div>
        </div>
      </fieldset>

      <div className="flex justify-end border-t border-slate-100 pt-4">
        <button type="submit" className="btn-primary" disabled={pending}>
          {pending ? "Saving…" : "Save settings"}
        </button>
      </div>
    </form>
  );
}
