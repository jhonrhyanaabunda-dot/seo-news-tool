# Phase 4 Audit — Product, UX & Architecture

**Date:** 8 October 2026
**Scope:** read-only inspection. No code changed, no migrations run, no production data touched.
**Baseline:** Phase 3 complete — 170/170 tests, authentication / authorization / tenancy / scanner / jobs / email all verified.

---

## 1. Executive summary

The engine is in better shape than the product is.

Three years' worth of the hard parts are already built and verified: a 39-check deterministic scanner, a grounded report findings contract, per-check priorities and recommendations, change detection, tenancy, a job queue and an email pipeline. **Phase 4 is overwhelmingly a presentation problem, not an engineering one.** The facts a dealership GM needs are already in the database, computed deterministically, and already pass through a validation layer that discards anything a model invents.

The gap is that the application is still shaped for the people who operate it. The dashboard is a *fleet* view — "Average SEO score across 1 scanned site", "Coverage 1/1", "Access restricted", "Scan failures (last 7 days)". That is the right screen for A3 staff watching a portfolio and the wrong screen for a General Manager who owns exactly one website. There is no dealership-first landing page, no opportunity framing, no PDF, and no plain-language explanation of what any number means.

Three findings shape the recommended plan:

1. **`ReportFindings` is already the single source of truth Phase 4 asks for.** It carries dealership, scan, score, category scores, counts, issues (with priority, affected pages, recommendation), score delta, new/resolved counts, protected pages, performance and news. The dashboard, the PDF and the emails can all read it, which is exactly how the "dashboard says 87, PDF says 92" failure gets designed out rather than tested for.
2. **Opportunities already exist as data.** Every check carries `label`, `problem`, `description`, `recommendation`, `severity`, `points`, a `CHECK_PRIORITY` of CRITICAL/HIGH/MEDIUM/LOW and a `ReportGroup`. Priority 3 is a view over existing fields, not a new scoring system — and it must not become one.
3. **PDF is the only item needing genuinely new infrastructure,** and `playwright-core` plus the Mac worker's Chrome mean it can be done with **zero new dependencies** — at the cost of a dependency on the Mac being awake. That trade-off is the main architectural decision in this audit.

Nothing in Phase 4 requires touching authentication, tenancy, the scanner or the job queue.

---

## 2. Existing functionality

### Frontend
| Area | State |
|---|---|
| Login + sign-in intro | Polished, already client-grade |
| Forgot / reset password | Complete |
| Portfolio dashboard (`/`) | Works; fleet-oriented |
| Dealership detail — 7 tabs | Overview, Issues, Pages, Protected, News, Reports, History |
| Report view component | Renders executive summary, critical issues, grouped issues, protected pages, news, recommended actions |
| Charts | `ScoreHistoryChart`, `CategoryBars` (hand-rolled SVG, no chart library) |
| Admin | Dealerships, Users, Settings, System |
| Loading states | 5 routes |
| Error / not-found | 1 each |
| Empty states | 5 pages |
| Mobile | No horizontal overflow at 320–1440 (verified Phase 3) |

### Backend
25+ server actions (every one guarded), 4 route handlers, resumable scan engine, Postgres job queue with 8 job types, email pipeline with dedupe and truthful statuses, grounded AI report path with deterministic fallback.

### Database
26 tables. Relevant to Phase 4: `dealerships`, `users`, `user_dealerships`, `seo_scans`, `scan_pages`, `seo_issues`, `seo_checks`, `scan_links`, `alerts`, `reports`, `report_runs`, `email_reports`, `news_articles`, `system_logs`.

---

## 3. Reusable components — build Phase 4 on these

| Asset | Why it matters |
|---|---|
| **`ReportFindings`** (`lib/reports/types.ts`) | The fact contract. Dashboard, PDF and email should all consume it. |
| **`ReportNarrative` + `groundNarrative`** | Already discards model output that does not match findings. Reuse verbatim for Priority 5. |
| **`CHECKS` catalogue** | 39 checks with client-readable `problem`, `description`, `recommendation`. This is the "why it matters / what to do" copy, already written. |
| **`CHECK_PRIORITY` + `REPORT_GROUPS`** | CRITICAL/HIGH/MEDIUM/LOW and 8 business groupings. Priority 3's prioritisation is already here. |
| **`computeScore`** | Deterministic, category-weighted, order-independent. **Do not replace.** |
| **`report-view.tsx`** | Already the report layout. Reuse as the PDF's HTML source. |
| **`changeSummary`** on `seo_scans` | Survives detail pruning; powers score delta, new and resolved issues. |
| **`getScanHistory`** | Real history for the trend chart. |
| **Charts** | Fine for the dashboard; will need re-rendering for print. |
| **Email templates** | Structure is sound; needs visual and copy work, not rebuilding. |
| **Tenancy layer** (`lib/auth/tenant.ts`) | Every new route and report must route through it unchanged. |

---

## 4. Missing functionality

1. **A dealership-first dashboard.** `/` is a portfolio table. A client sees a one-row table and fleet statistics.
2. **PDF reports.** No generator, no storage, no dependency. The single highest-value commercial gap.
3. **An opportunities view.** The data exists; no screen presents it as "what to do next".
4. **Plain-language explanations.** No "What does this mean?" anywhere.
5. **Page health rollup.** `scan_pages` holds per-page results but nothing aggregates healthy / warning / critical.
6. **Dealership branding.** `dealerships` has `name`, `websiteUrl`, `brand`, `dealerGroup`, `city`, `state` — **no logo, no colour**. Phase 4's branding needs a migration or must be scoped to name/brand/website only.
7. **Onboarding.** None.
8. **Report delivery history per dealership.** `email_reports` has the data; no client-facing view.
9. **Initiator logging on scan actions.** `scanNowAction` writes no log (carried from Phase 3).

---

## 5. Partial functionality

| Feature | Today | Needed |
|---|---|---|
| Reports | Generated, stored, viewable in a tab; **1 ever created**, AI disabled (no API key) | Monthly framing, PDF, email delivery |
| Score trend | Chart exists on the History tab | Promote to the dashboard; 7/30/90-day framing; honest empty state |
| Alerts | 6 types stored | No client-facing feed |
| Issues | Full table with filters | Needs severity grouping and "why it matters" |
| Email | Delivers reliably, truthful statuses | Plain styling; not dealership-branded |
| AI narrative | Fully built and grounded | Switched off in production |
| Recipients | Settings + per-dealership | No per-type control, no client view |

---

## 6. UX problems from a GM's perspective

1. **The landing page answers the wrong question.** A GM asks "how is *my* site?" and gets portfolio aggregates.
2. **Operations vocabulary leaks into the client view** — "Coverage", "Access restricted", "Scan failures (7 days)", "Schedule". These are A3's concerns.
3. **Nothing explains itself.** A score of 85 has no stated meaning, scale or basis.
4. **Issues are a list, not a priority.** The Issues tab opens with filter chips and a long table.
5. **No "what changed" narrative** on the dashboard, though `changeSummary` holds exactly that.
6. **Nothing to hand upward.** CSV is an internal artefact; a GM forwards a PDF.
7. **Protected pages read as a failure** rather than as "the site's firewall blocked us; not an SEO problem".
8. **Seven tabs** is an analyst's information architecture.
9. **10px chart axis labels** (Phase 3 finding) are small on mobile.
10. **No positive reinforcement** — 39 checks pass silently; only failures are visible.

---

## 7. Technical risks

| Risk | Severity | Note |
|---|---|---|
| **PDF needs Chromium** | High | Not available on Vercel. Either the Mac worker generates PDFs (new failure mode: Mac asleep → no report) or a new JS library duplicates layout. |
| **PDF storage** | High | No object storage configured. Options: regenerate on demand, store bytes in Postgres, or add blob storage (new infrastructure + env vars). |
| **Dashboard query cost** | Medium | A richer dashboard will add queries. F-4 (missing `seo_scans` composite index) and F-5 (news N+1) are still open and would compound. |
| **Two sources of truth** | High | If the PDF recomputes anything, dashboard and PDF will disagree. Mitigated by consuming `ReportFindings` only. |
| **Detail pruning** | Medium | Only the 10 newest scans keep issue rows. A monthly PDF built from an older scan has counts but no detail. The Phase 3 disclosure must extend to PDFs. |
| **AI cost and latency** | Medium | Enabling the narrative adds spend and a slow path. Already guarded by a monthly limit and a deterministic fallback. |
| **Branding scope creep** | Medium | Logo upload implies file storage, validation and SSRF considerations. Recommend deferring. |
| **Regression surface** | Medium | Priorities 1 and 6 touch shared components (`ui.tsx`, charts) used by admin screens too. |
| **Email rendering** | Low | Richer HTML risks client compatibility; tables and inline CSS only. |

---

## 8. Database changes required *(proposed only — nothing executed)*

| # | Change | For | Necessity |
|---|---|---|---|
| 1 | `reports.kind` — `'adhoc' \| 'monthly' \| 'weekly'`, plus `period_start` / `period_end` | Monthly reports | **Required** for Priority 2 |
| 2 | `report_files` table — `report_id`, `format`, `bytes` (or URL), `size`, `generated_at` | PDF storage | **Required** unless PDFs regenerate on demand |
| 3 | `dealerships.logo_url`, `dealerships.brand_color` | Branding | **Optional** — defer unless asked |
| 4 | Composite index `seo_scans (dealership_id, status, completed_at desc)` | Dashboard performance | **Recommended** (closes F-4) |
| 5 | `job_type` += `'report_pdf'` | PDF as queued work | Required only if PDFs are generated by the worker |

**No new tables are needed for opportunities, page health, trends or alerts** — all derivable from existing tables. That is the right answer to the "can existing tables support this?" rule.

---

## 9. API / route changes required

| Route | Type | Purpose |
|---|---|---|
| `/dealerships/[id]` default tab | Modified | Dealership-first overview |
| `/dealerships/[id]/report/[reportId]/print` | **New** | Print-optimised HTML — the PDF's source |
| `/dealerships/[id]/report/[reportId].pdf` | **New** | Authorized download; must go through `requireDealershipAccess` |
| `generateReportAction` | Modified | Accept report kind / period |
| `/api/cron/tick` | Unchanged | Gains a `report_pdf` branch only if option A is chosen |

No new public endpoints. No new authentication surface.

---

## 10. Recommended Phase 4 architecture

```
                       seo_scans · seo_issues · scan_pages
                       alerts · news_articles · reports
                                    │
                                    ▼
                       buildFindings()  ──►  ReportFindings
                            (deterministic, already exists)
                                    │
                 ┌──────────────────┼──────────────────┐
                 ▼                  ▼                  ▼
          Client dashboard    report-view.tsx      Email templates
           (Priority 1)        (Priority 2)         (Priority 4)
                                    │
                                    ▼
                            print route → PDF
                                    ▲
                                    │
                    optional AI narrative (Priority 5)
                    grounded against the same findings
```

**One rule carries the whole design: every surface renders `ReportFindings`; nothing recomputes it.** That makes "dashboard says 87, PDF says 92" structurally impossible rather than a thing to test for.

### PDF generation — the decision to make

| Option | Deps | Runs on | Trade-off |
|---|---|---|---|
| **A. Playwright print** of the HTML report | **None** (`playwright-core` present) | Mac worker | Reuses `report-view.tsx` → one source of truth. Fails when the Mac sleeps. |
| **B. JS PDF library** (pdfkit / React-PDF) | New | Vercel | Always available; duplicates layout; drifts from the HTML report over time. |
| **C. Print-optimised HTML only**, no PDF file | None | Anywhere | Cheapest; not a forwardable deliverable. |

**Recommendation: A, with C shipped first.** The print route is useful on its own, is the input to A, and lets the layout be reviewed before any infrastructure is added. If the Mac dependency proves unacceptable, B becomes a contained swap behind the same route.

---

## 11. Recommended implementation order

| Step | Work | Risk | Why here |
|---|---|---|---|
| **4A.1** | Dealership overview tab — score, delta, page health, top issues, trend, explanations | Low | Pure presentation over existing queries |
| **4A.2** | Role-aware landing: clients land on their dealership; staff keep the portfolio view | Low | Small routing change; no tenancy change |
| **4C** | Opportunities view from `CHECK_PRIORITY` + `CHECKS` | Low | Data exists; feeds both dashboard and PDF — **before** the PDF |
| **4B.1** | Print-optimised HTML report route | Low | Reviewable without infrastructure |
| **4B.2** | PDF generation + storage + download | **High** | The only infrastructure step; isolate it |
| **4D** | Email presentation, previews, recipient visibility | Medium | Pipeline untouched, templates only |
| **4E** | Enable AI narrative (optional) | Low | Config + verification; fallback already proven |
| **4F** | Onboarding, loading/empty/error copy, mobile pass, demo safety | Low | Polish last, over a settled IA |

Opportunities deliberately precede the PDF: the PDF has an opportunities section, and building it twice is the waste worth avoiding.

---

## 12. Do not change

These are verified and carry no Phase 4 requirement:

- **Authentication** — sessions, bcrypt, rate limiting, password reset and its queued retry.
- **Authorization and tenancy** — `lib/auth/tenant.ts`, the layout guards, the 404-not-403 behaviour, the HTTP matrix.
- **Scanner** — `scan-engine.ts`, `checks/`, `scoring.ts`. Score methodology stays as it is; Phase 4 presents it, never recalculates it.
- **Job queue** — claiming, SKIP LOCKED, dedupe keys, stale recovery, the offline-crawler requeue rule.
- **Email delivery core** — `send.ts`, dedupe keys, `sent`/`failed`/`skipped` semantics, the zero-recipient rule.
- **Grounding layer** — `ground.ts`. It is the reason AI can be enabled safely.
- **Migrations 0000–0015.**
- **All 170 tests.** New tests add to this number; none is relaxed.

---

## 13. Open questions for approval

1. **PDF option A, B or C?** Determines whether the Mac becomes a reporting dependency.
2. **Dealership logos?** Needs a migration plus file handling; recommend deferring.
3. **Enable the AI narrative?** Needs `ANTHROPIC_API_KEY` in production and carries per-report cost.
4. **Should staff keep the portfolio dashboard** while clients get a dealership view? (Recommended.)
5. **Take F-4's index now,** since 4A adds dashboard queries?

---

## 14. Summary

| | |
|---|---|
| **EXISTING** | Scanner, scoring, findings contract, priorities, recommendations, change detection, tenancy, jobs, email, grounded AI path, report view |
| **MISSING** | Dealership dashboard, PDF, opportunities view, explanations, page health rollup, onboarding, branding fields |
| **REDESIGN** | Landing IA, issue presentation, email styling, client vocabulary |
| **REUSE** | `ReportFindings`, `CHECKS`, `CHECK_PRIORITY`, `computeScore`, `report-view.tsx`, `changeSummary`, charts, tenancy |
| **RISKS** | Chromium for PDF, PDF storage, duplicate sources of truth, pruning in monthly reports, dashboard query cost |
| **PLAN** | 4A dashboard → 4C opportunities → 4B print then PDF → 4D email → 4E AI → 4F polish |

Phase 4 is mostly presentation work over data that already exists and is already verified. The one genuinely new piece of infrastructure is PDF generation, and it should be isolated behind its own step.
