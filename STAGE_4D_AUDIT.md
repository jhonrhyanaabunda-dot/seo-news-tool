# Stage 4D-1 — Email Audit and Implementation Plan

**Date:** 9 October 2026 · **Mode:** read-only inspection · **Baseline:** 239/239 tests
No code changed, no migration run, no email sent.

---

## 1. Email types: what exists, what does not

`email_kind` has six values. Production has sent 66 emails, all `sent`, zero failed, zero duplicate dedupe keys.

| Email | Exists | Production volume | Template |
|---|---|---|---|
| Critical/important alert | **Yes** | 33 | `renderAlertEmail` |
| Daily digest | **Yes** | 20 | `renderDigestEmail("daily")` |
| Weekly digest / Monday newsletter | **Yes** | 3 | `renderDigestEmail("weekly")` |
| Report delivered | **Yes** (admin-triggered) | 0 | `renderReportEmail` |
| Password reset | **Yes** | 0 | `renderPasswordResetEmail` |
| Test email | **Yes** | 10 | `renderTestEmail` |
| Crawler offline/online | **Yes** (staff only) | included in alerts | `renderCrawlerStatusEmail` |
| **Monthly SEO report** | **No** | — | — |
| **Scan-completion notification** | **No** | — | — |

The **Monday SEO/news digest already exists** — it is the weekly digest, which leads with industry stories from `getTopSeoStories` and then covers every dealership.

**Recommendation: do not build the monthly report or scan-completion emails in 4D.** The spec says to confirm rather than assume. A monthly report would need a `monthly` kind, a scheduler gate, a period concept and a retention answer (detail is pruned after 10 scans, so a month-old scan has no findings). Scan-completion emails would fire ~17×/week per the current cadence and would be noise. Both are product decisions, not reliability work, and 4D's stated priority is reliability and tenant isolation.

## 2. Triggers

| Email | Trigger | Type |
|---|---|---|
| Daily digest | `scheduler.ts:109` — local hour ≥ `dailyDigestHour` (7), one claim per local date | Scheduled |
| Weekly digest | `scheduler.ts:113` — weekday = `weeklyDigestWeekday` (Mon), hour ≥ 7 | Scheduled |
| Alert | `alerts.ts` enqueues an `alert` job on critical change | Event |
| Crawler offline/online | Offline detector each tick, inside the quiet window added in Phase 2 | Scheduled |
| Report delivered | `emailReportAction`, admin only | Manual |
| Password reset | Inline on request; failure retries via the `password_reset` job | User |
| Test / newsletter preview | Admin button, 5/hour | Manual |

## 3. Recipients

Resolution is `unique(dealership.notificationEmails ∪ settings.managementRecipients)`, lowercased. The weekly digest additionally sends the whole portfolio to management plus `newsletterRecipients`. Crawler alerts fall back to active admins.

**Production today: 1 management recipient, 0 newsletter recipients, and 0 dealerships with their own notification address.** Every email therefore goes to one mailbox, and `email_reports` shows one recipient per row — the send loop is per-recipient, so one dealership's list can never be handed another's content.

**Validation: sound on every path.** `managementRecipients` and `newsletterRecipients` use `z.string().email()`. `dealerships.notificationEmails` arrives as free text but is then put through `parseEmailList` ([sanitize.ts:17](src/lib/security/sanitize.ts#L17)), which splits on commas/newlines/semicolons, lowercases, de-duplicates, caps at 320 characters, and **returns invalid entries separately so the form rejects the save** with "These addresses are not valid: …" ([service.ts:98](src/lib/dealerships/service.ts#L98)). Empty entries are dropped.

The only residual observation is that the address pattern is pragmatic rather than RFC-complete (`[^\s@]+@[^\s@]+\.[^\s@]{2,}`). That is a deliberate and defensible trade-off — a stricter regex rejects valid addresses more often than it catches bad ones — and I do **not** propose changing it.

## 4. Sender and credentials

`EMAIL_FROM` is validated before any send by `emailConfigProblem`: sender shape, placeholder domains, Gmail's requirement that `EMAIL_FROM` equal `SMTP_USER`, port/TLS mismatch, and App Password shape. Misconfiguration fails fast with an explanation rather than a provider rejection.

**No `Reply-To` is set anywhere.** Replies go to `jabunda@a3brands.com`, which is tolerable today but wrong once a dealership replies to a report.

Secrets: `config.ts` exposes only the `SMTP_USER` and `EMAIL_FROM` *addresses* on an admin page, never the password. No credential appears in logs or in `email_reports`. Verified again in this audit.

## 5. Retries, idempotency, delivery records, failure visibility

Working, and improved in Phases 2–3:

- **Idempotency:** `sendTrackedEmail` writes a row keyed on `dedupe_key` before sending; an already-`sent` or `skipped` key short-circuits. A retried digest job skips recipients already served. **Zero duplicate dedupe keys across all 66 production rows.**
- **Retry:** job-level with exponential backoff — digests 5 attempts, alerts 3, password-reset 2. Permanent failures land in the admin failed-jobs table with a manual retry.
- **Records:** `email_reports` holds kind, dealership, recipients, subject, status, provider message id, error, period.
- **Zero recipients** is recorded `skipped` with a reason and no longer marks an alert notified (Phase 2 fix).

**Gaps:**
- **No `delivered` state, and there cannot be one.** `sent` means Gmail SMTP accepted the message. The enum (`pending|sent|failed|skipped`) has no `delivered`, which is honest — but the admin UI labels the column "Status", which invites reading `sent` as "received". Wording fix, not a schema fix.
- **No `retrying` state.** A failed attempt shows `failed` while its job is still scheduled to retry, so the log overstates finality.
- **Failure visibility is thin** (Phase 1 finding, still open): the system page shows the 50 newest rows unfiltered, with the error only in a `title` tooltip — invisible on touch and to keyboard users — and no failed-email count.

## 6. Scheduled-job behaviour

- **Restart:** jobs live in Postgres; a restarted worker reclaims them. Stale `running` jobs are recovered after 15 minutes, and Phase 2 made an interruption during a crawler outage not spend an attempt.
- **Duplicates:** `claimPeriod` is atomic and keyed on the local date, so overlapping ticks produce one digest. A partial unique index stops two active jobs sharing a dedupe key.
- **Missed execution:** the gate is `hour >= configured` plus a per-date claim, so a tick missed at 07:00 still fires at 08:00 the same day.
- **Timezone:** `America/Chicago` via `Intl`, verified correct across both DST transitions in Phase 3.
- **Known gap (Phase 1 J-04, still open):** the period is claimed *before* the job succeeds, so a digest exhausting its attempts never retries that day.

## 7. Report data: does email agree with the dashboard, opportunities and PDF?

**Score, counts and changes: yes.** `buildDealerDigest` reads `seo_scans` directly — the same stored row the dashboard and PDF read.

**Finding order: no.** This is the real finding of this audit.

[reports.ts](src/lib/email/reports.ts) computes its own top issues:

```sql
order by case when severity = 'critical' then 0 else 1 end, count(*) desc limit 3
```

That is **severity-then-count**. The dashboard, the opportunities page and the PDF all use `compareOpportunities`: **priority (CRITICAL/HIGH/MEDIUM/LOW) → affected pages → check key.** Severity has three values; priority has four and is a deliberate editorial layer on top. A `warning`-severity check mapped to `HIGH` priority outranks other warnings everywhere in the product **except in email**.

So a GM can receive a digest listing one set of issues and open the dashboard to a different order — exactly the "dashboard says 87, PDF says 92" failure mode the earlier stages designed out, reappearing in the one surface that reaches them first. `reports.ts` already imports `CHECKS_BY_KEY` for labels but not `priorityFor`.

## 8. Email links and authorization

Links are `${APP_URL}/dealerships/{id}` and `${APP_URL}` — plain application URLs with **no tokens**. The destination enforces access through the Phase 3 layout guard (`requireDealershipAccess`), so a forwarded link grants nothing: a recipient without an account is redirected to sign in, and one signed in as another dealership gets a 404.

**No render keys appear in any email.** The 4B-2 key is minted only for the worker and never leaves the job payload. Confirmed by inspection.

## 9. News accuracy in the digest

Industry stories carry source and publication date. **Per-dealership news does not:** the query selects only `id, title, url, source` ([reports.ts:68](src/lib/email/reports.ts#L68)) and the template renders title + source with no date. The spec requires real publication dates and forbids presenting stale news as current. Articles are filtered to `detectedAt >= periodStart`, so they are recent *to us* — but "when A3 noticed it" is not "when it was published".

## 10. Proposed changes — minimum set

**No schema migration is required for any of this.** Every change below uses existing columns and existing jobs.

| # | Change | Why | Risk |
|---|---|---|---|
| 1 | ~~Validate `notificationEmails`~~ — **withdrawn: already validated by `parseEmailList`** | No change needed | — |
| 2 | Email findings use `compareOpportunities` / `priorityFor` | Removes the last duplicate ordering in the product | Low |
| 3 | Add `publishedAt` to the dealership-news query and render it | Truthful dates; stop implying stale news is current | Low |
| 4 | Add a configured `Reply-To` | Replies currently land in the sending mailbox | Low |
| 5 | Show "Accepted by provider" rather than "Sent"; show a *retry pending* state while a job is still scheduled | Status must not overstate delivery | Low |
| 6 | Failed-email count + filter on the system page; move the error out of the tooltip | Phase 1 finding, still open | Low |
| 7 | Template polish: mobile width, score-change only when a real comparison exists, pruned-scan disclosure, one clear next step | 4D's product goal | Medium (touches shared templates) |

**Deliberately excluded:** monthly report, scan-completion emails, PDF attachments, object storage, a second scheduler, a new delivery table, an admin email dashboard, AI narrative (4E).

### Testing approach

All verification through a **mock provider / test sink**. `EMAIL_PROVIDER=console` already exists and logs instead of sending; the password-reset suite uses it today. **No real email will be sent.** Production recipients are never substituted into tests — every test creates its own `@example.invalid` addresses.

---

## Decisions I need from you

1. **Reply-To address.** Which mailbox should dealership replies reach? Without an answer I will leave `Reply-To` unset rather than guess.
2. **Monthly report — confirm deferral.** I recommend excluding it from 4D for the reasons in §1. Say the word if you want it in scope instead.
3. **Email template restyle depth.** Item 7 touches templates shared by alerts, digests and reports. I propose a conservative pass — spacing, mobile width, truthful conditionals — rather than a visual redesign, so the Phase 2 delivery guarantees stay untouched.

I have not started implementation. Confirm the plan, answer the three questions above, and I will proceed.
