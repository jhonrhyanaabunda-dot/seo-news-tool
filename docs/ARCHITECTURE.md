# Production architecture

This document explains how the A3 SEO & News Monitor is built, what runs where, and why each component can (or cannot) run on Vercel.

## 1. Vercel feasibility analysis

| Component | Where it runs | Vercel-compatible? | Reasoning |
|---|---|---|---|
| Dashboard, reports, admin UI | Vercel (Next.js server components) | ✅ Yes | Standard request/response rendering against Postgres. |
| Auth, server actions, API routes | Vercel Functions (Node.js runtime) | ✅ Yes | Short-lived; sessions live in Postgres, not memory. |
| Scheduler | Vercel Cron → `GET /api/cron/tick` every 10 min | ✅ Yes (Pro) / ⚠️ Hobby | Hobby cron jobs are limited to once a day, so Hobby deployments use the included GitHub Actions heartbeat (or any HTTP scheduler) instead. |
| SEO crawler | Vercel Functions, **resumable** jobs | ✅ Yes, by design | A full site crawl does not fit in one function invocation, so a scan is a persisted state machine: each tick crawls until its time budget (default 240 s), saves progress in Postgres, and the next tick resumes. No process has to stay alive. |
| HTML analysis | In-process (cheerio) | ✅ Yes | Pure JavaScript parsing; no browser. |
| JavaScript rendering / Lighthouse | **Not on Vercel** — Google PageSpeed Insights API (optional) | ❌ Chromium on Vercel is not reliable | Headless Chromium exceeds practical function size/memory/time limits and is fragile in serverless. Lab performance metrics come from Google's hosted Lighthouse instead. |
| SEO crawler location | US region: Vercel iad1 (`CRAWLER_MODE=vercel`) or regional workers (`CRAWLER_MODE=worker`) | ✅ Yes | Crawling never depends on a personal computer or its location. Regions can be added and chosen per dealership. |
| Sites behind bot protection | Detected, recorded and reported | ✅ Yes (no bypassing) | The monitor never circumvents Cloudflare or other controls. Blocked pages are marked "Not evaluated"; a limited homepage check may come from Google PageSpeed Insights, clearly labelled as an alternative source. |
| JavaScript challenge pages | Optional real-browser rendering on the worker (`BROWSER_RENDERING=fallback`) | ➕ Add-on (never on Vercel) | A refused page may be re-requested with Chromium, which runs the JavaScript some sites require before serving HTML. The honest `A3SEOMonitor` User-Agent and robots.txt still apply and no stealth patches are used, so this is a transport change, not a disguise. Pages read this way are recorded as `scan_pages.fetch_method = 'browser'`. |
| News monitoring | Vercel Functions | ✅ Yes | A few RSS/API requests per dealership (~20 s). |
| Email | Resend HTTPS API (or SMTP) | ✅ Yes | API-based delivery; no local mail server. |
| Database | Managed PostgreSQL (Neon, Supabase, RDS…) | ✅ Yes | Use the pooled connection string. |
| Large portfolios | Optional standalone worker (`worker/`) | ➕ Add-on | Same code and queue, runs as an always-on container when cron throughput is not enough. |

**Nothing depends on a local machine**: no local files, no local database, no long-running process, no localhost services.

## 2. Component diagram

```
                       ┌──────────────────────── Vercel ────────────────────────┐
  QA / managers ──────▶│ Next.js app (dashboard, reports, admin, auth)          │
     (browser)         │   server components + server actions                   │
                       │                                                         │
  Vercel Cron ────────▶│ /api/cron/tick  (Bearer CRON_SECRET, maxDuration 300s)  │
  (or GitHub Actions)  │   1. scheduler: enqueue due scans/news/digests          │
                       │   2. runner: claim jobs (SKIP LOCKED), run until budget │
                       └───────────────┬───────────────────────┬─────────────────┘
                                       │ SQL (pooled)          │ HTTPS
                       ┌───────────────▼───────┐   ┌───────────▼──────────────────────────┐
                       │ PostgreSQL            │   │ Dealership websites (crawler)         │
                       │ dealerships, scans,   │   │ Google News RSS / Bing News RSS       │
                       │ pages, issues, news,  │   │ NewsAPI / GNews (optional)            │
                       │ jobs, alerts, emails  │   │ PageSpeed Insights (optional)         │
                       └───────────────▲───────┘   │                                       │
                                       │           │ Resend / SMTP (email)                 │
  regional crawlers   ┌────────────────┴────────┐  └───────────────────────────────────────┘
  US-East/Central/West│ worker/ (container)     │
                      │ same runTick() in a loop│
                      └─────────────────────────┘
```

### How components communicate

* **All coordination goes through Postgres.** The web app, cron ticks and the optional worker never call each other; they read and write the same tables.
* The **`jobs` table is the queue.** Producers (scheduler, "Scan now" button, alerts) insert rows; consumers claim them with `UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)`, so any number of ticks/workers can run concurrently without double-processing.
* **Manual actions start immediately**: server actions enqueue the job and then call `after()` to process it right after the response is sent (Vercel keeps the function alive via `waitUntil`); unfinished work continues on the next cron tick.
* **External services** are reached over HTTPS through isolated modules:
  `src/lib/news/providers.ts`, `src/lib/email/provider.ts`, `src/lib/seo/pagespeed.ts`, `src/lib/seo/remote-audit.ts`.

## 3. The resumable scan pipeline

```
queued ─▶ init ─▶ crawl ─▶ links ─▶ finalize ─▶ completed
            │        ▲  │      ▲  │
            │        └──┘      └──┘   (each loop = one tick; state saved in seo_scans.crawl_state)
            └─▶ blocked / site down ─▶ finalize (site-level checks only, score = null)
```

1. **init** – fetch robots.txt (respecting `A3SEOMonitor` rules and `Crawl-delay`), fetch the homepage (following a cross-domain redirect), detect bot-protection challenges, load the XML sitemap (index + gzip aware), and seed the frontier: homepage links first, key dealership pages prioritised, a bounded sample of sitemap URLs last.
2. **crawl** – one page at a time per site (politeness delay, default 750 ms), SSRF-validated on every redirect hop, 15 s timeout, 3 MB cap, one retry for transient failures. Frontier rows are `scan_pages` with `status = pending`, ordered by `(priority, depth, id)` so crawls are deterministic. Inventory-heavy sections are capped (e.g. 3 vehicle detail pages).
3. **links** – every discovered link is stored once per scan (`scan_links`). Targets that were crawled inherit their result; a deterministic sample (top 150 internal / 100 external by occurrence) is status-checked. A link is **broken** only when the target demonstrably fails: HTTP 404/410, a 5xx server error, or (internal links) a DNS/connection/timeout failure. Responses of 401/403/429 mean the site's security refused the *check*, which is common on dealer platforms, so those links are recorded as "unverifiable". Social networks, marketplaces and manufacturer configurator domains (`UNVERIFIABLE_LINK_HOSTS`) are never checked, to avoid false alarms.
4. **finalize** – the stored crawl is evaluated by a **pure function** (`evaluateScan`) into issues and check results, scored by `computeScore`, compared to the previous comparable scan by issue fingerprints, and persisted in one transaction. Alerts are created afterwards.

A scan that keeps failing is retried with exponential backoff (3 attempts), then marked failed with a readable reason and a `scan_failed` alert. Jobs abandoned by a killed invocation are recovered after 15 minutes.

## 4. Deterministic scoring

* Rules live in `src/lib/seo/checks/config.ts` (39 checks in 7 categories, with weights, severities, thresholds and deduction tiers).
* Page-level checks deduct a fraction of their points according to the **share of pages affected** (tiered); site-level checks are pass/fail (key pages: proportional).
* Category score = `100 × (1 − deducted / applicable points)`; overall = weighted mean of categories with applicable checks.
* Inputs are only the stored crawl data — no clock, network or randomness — and crawl order is deterministic, so the same site under the same conditions produces the same score. Unit tests assert this.
* Lighthouse (PageSpeed) results are shown but deliberately **excluded** from the score because they vary between runs.

## 5. Change detection

* Every issue has a **fingerprint** `sha256(checkKey | url-without-scheme/www | subject)`, stable across scans.
* Each completed scan stores its compact fingerprint list (`issue_fingerprints`, `<severity char><hash>`) permanently, even after page-level details are pruned.
* Scan-to-scan: new issues, resolved issues, score delta (vs. the last scan where the site was reachable), and availability transitions.
* Digests compare the latest scan with the last scan *before the reporting period*, so an issue that appears and disappears within the day is not reported twice.
* The first scan of a dealership only establishes a baseline — nothing is "new" yet, so no alert storm on onboarding.

## 6. Notifications

| Event | Delivery |
|---|---|
| Website unavailable (transition only) | Immediate email (if enabled) + digest |
| New critical SEO issues | Immediate email (if enabled) + digest |
| Scan blocked by site security (transition only) | Digest |
| Significant score drop / gain (≥ threshold) | Digest |
| Resolved issues | Digest |
| New relevant news (relevance ≥ threshold) | Digest |
| Scan failures | Digest + System page |

* **Digests are sent only when something meaningful changed** for at least one of the recipient's dealerships (configurable).
* One email per recipient containing all of their dealerships (dealership contacts + management recipients).
* Duplicate prevention: alerts have unique dedupe keys; every email has a unique `email_reports.dedupe_key` written *before* sending, so retries and overlapping ticks never send twice; digest periods are claimed atomically.

## 7. Database schema (PostgreSQL)

Defined in `src/lib/db/schema.ts`; SQL migrations in `drizzle/`.

| Table | Purpose | Key constraints / indexes |
|---|---|---|
| `users` | Accounts (admin / viewer), bcrypt password hashes | unique `lower(email)` |
| `sessions` | Opaque session tokens (SHA-256 hashed) | unique token hash, FK user (cascade) |
| `dealerships` | Monitored dealerships, contacts, toggles, schedule override | index on host, active |
| `news_keywords` | Auto (name, group, brand, city) + custom keywords | unique `(dealership, lower(keyword))` |
| `seo_scans` | One row per scan: status, score, category scores, counts, site checks, change summary, fingerprints, crawl state | **partial unique index: one active scan per dealership** |
| `scan_pages` | Crawl frontier + per-page results (status, **result class**, title, meta, H1/H2, canonical, indexability, timings, schema, OG…) | unique `(scan, normalized_url)`, index `(scan, result_class)` |
| `scan_links` | Link targets per scan with check result (only broken ones kept after finalize) | unique `(scan, url)` |
| `seo_checks` | Per-check result and points deducted (score breakdown) | unique `(scan, check_key)` |
| `seo_issues` | Issues with severity, page URL, message, recommendation, first-detected date, fingerprint | index `(scan, severity)`, `(scan, fingerprint)` |
| `scan_events` | Scan timeline / log | index `(scan, created_at)` |
| `news_articles` | Articles per dealership with source, dates, relevance score/status, topics | **unique `(dealership, url_hash)`**, index on title hash |
| `alerts` | Change events | **unique `dedupe_key`** |
| `email_reports` | Every email attempt (digest / alert / test) | **unique `dedupe_key`** |
| `jobs` | Durable job queue (types: seo_scan, news_scan, report, digest, alert, maintenance) | **partial unique `dedupe_key` for queued/running**, pick index |
| `news_sources` | Configured RSS/Atom feeds: dealership news, manufacturer newsrooms (optionally shared per brand), publisher feeds | unique `(coalesce(dealership, 0), lower(url))` |
| `reports` | SEO reports: deterministic findings, grounded narrative, generator (ai/deterministic), input hash for reuse | index `(dealership, created_at)`, `(dealership, input_hash)` |
| `report_runs` | One row per model call (status, tokens, duration) — the monthly AI budget | index `created_at` |
| `settings` | App settings + atomic period markers | PK key |
| `system_logs` | Persisted warnings/errors | index `(level, created_at)` |
| `rate_limits` | Fixed-window counters shared across instances | PK key |

**Scale:** all hot queries are index-backed and per-dealership. Page/issue detail rows are kept for the 10 most recent scans per dealership (maintenance prunes older ones), while score history, counts and fingerprints are kept for the retention period — so storage grows with the number of dealerships, not with time.

## 8. Capacity

With defaults (40 pages/scan, 750 ms politeness delay, 4 parallel jobs per tick, 240 s budget, tick every 10 min):

* One scan ≈ 2–7 minutes of crawl time (mostly politeness delay and link checks), split across ticks.
* Throughput ≈ 4 jobs × 24 min of processing per hour ≈ **150–400 dealership scans per day** from Vercel Cron alone.
* For daily scans of larger portfolios: raise `JOB_CONCURRENCY` (network-bound, not CPU), run the tick more often, and/or run the standalone worker (`npm run worker`, `worker/Dockerfile`) — it drains the same queue continuously alongside the cron.

## 9. Security

* Authentication: bcrypt (cost 12), opaque DB-backed sessions (httpOnly, SameSite=Lax, Secure in production), revocable; login rate-limited per IP and per email.
* Authorization: `proxy.ts` gates every non-public route; every page and server action re-checks the session and role server-side (admin vs viewer).
* Validation: zod schemas for every form and action; text is sanitised; emails and URLs normalised.
* SSRF: only http(s) on ports 80/443, DNS resolution checked against private/link-local/metadata ranges (IPv4 + IPv6), re-validated on every redirect hop; applied to dealership URLs on save and to every fetch.
* Cron endpoint: constant-time Bearer secret comparison; returns 401 otherwise.
* Secrets only in environment variables, read by a `server-only` module so they cannot be bundled into client code.
* Security headers (HSTS, frame deny, nosniff, referrer policy); the app is marked `noindex`.

## 10. Regional crawlers, access restrictions & scan outcomes

**Flow.** Vercel dashboard → API/server actions → `jobs` table (the API contract between app and crawlers) → cloud crawler worker in the job's region → dealership website → results in PostgreSQL → dashboard + email. The web app never calls a crawler directly and never waits for one, so it stays available while crawlers run, restart or are offline.

**Regions.** `seo_scans.region` / `jobs.region` hold the requested region (the dealership's *Preferred crawler region* or `DEFAULT_CRAWLER_REGION`). Workers claim only jobs for their `WORKER_REGION` (`claimNextJob` filter) and report to `crawler_workers` (heartbeat). The scheduler moves scan jobs to the default region if their region has had no crawler online for 30 minutes. `seo_scans.crawler_id` and `site_checks.crawledFrom` record where each scan actually ran.

**Access restrictions (no circumvention).**

| Situation | Behaviour |
|---|---|
| Homepage refused (401/403/challenge) | Scan outcome **Blocked**. The URL, status and reason are recorded, nothing is scored, optional labelled Google PageSpeed homepage check runs, and one alert is sent on transition. |
| Page refused mid-crawl | That page is marked "Access restricted". After 2 consecutive refusals, crawling stops and the remaining pages are marked **Not evaluated**. Outcome: **Partially blocked**. |
| HTTP 429 | Crawling of the site stops immediately. |
| Refused robots.txt / sitemap | State "unknown", never "missing", and never cached. |
| Retries | Only timeouts, dropped connections and 5xx, once. 401/403/429/challenges are never retried. |
| Rescheduling | Consecutive blocked scans back off the interval (×2, ×4, ×8, max 7 days). |
| Change detection | Issues on unevaluated pages are not "resolved"; blocked/partial scans are not baselines. |

**Scan outcome** (`seo_scans.outcome`): `completed`, `completed_with_warnings` (non-security failures or site down), `partially_blocked`, `blocked`, `failed`. It is computed by `computeOutcome()` in `src/lib/seo/outcome.ts` and shown in the dashboard, report, history and emails, separately from SEO issue counts.


## 11. Protected pages, crawl-job API, reports and news sources

**Sitemap-first frontier.** `initPhase` loads robots.txt, then the admin-configured sitemap, robots.txt `Sitemap:` entries, `/sitemap.xml` and `/sitemap_index.xml`, and seeds the page budget from the sitemap (ordered by dealership page importance, `orderSitemapUrls`) *before* homepage links are enqueued. Links only fill the remaining budget.

**Result classes.** At finalize, every requested URL gets `scan_pages.result_class` from the pure `classifyPageResult()`: SUCCESS, REDIRECT, NOT_FOUND, CLIENT_ERROR, PROTECTED (challenge page), ACCESS_DENIED (401/403), RATE_LIMITED (429), SERVER_ERROR, TIMEOUT, NETWORK_ERROR, NOT_EVALUATED, SKIPPED. Public job status (`crawlJobStatus()`): QUEUED, RUNNING, COMPLETED, PARTIAL (completed with protected pages, including fully blocked sites), FAILED (the monitor failed).

**Crawl-job API.** `POST /api/crawl-jobs` and `GET /api/crawl-jobs/{id}` (Bearer `CRAWLER_API_TOKEN`, constant-time compare) create and read `jobs` rows. Nothing calls a worker over HTTP; workers pull from Postgres, which keeps them provider-independent and lets them run without any inbound port.

**Reports.**

```
generate (UI/API) → reports row (queued) + report job
  → buildFindings()  deterministic facts from seo_scans / seo_issues / seo_checks / scan_pages / news_articles
  → findingsHash()   sha256(findings + model + REPORT_VERSION)
      ├─ same hash as a completed AI report → reuse narrative (no model call)
      ├─ no ANTHROPIC_API_KEY / monthly limit reached → deterministicNarrative()
      └─ reserveModelCall() under pg_advisory_xact_lock → Claude (structured output, fallbacks: "default")
           → groundNarrative(): drop ungrounded actions/highlights/numbers; priorities & counts from findings
  → reports row (completed) → Reports tab / email
```

Report jobs need about 2.5 minutes of budget, so they run on cron ticks or a worker running all job types, not in the short post-request `after()` kick. Transient API failures (429, 5xx, connection) retry the job; other failures fall back to the deterministic narrative.

**Capacity (≈300 reports/month).** Findings are one indexed query set per report. Model calls are bounded by `AI_REPORTS_MONTHLY_LIMIT`; unchanged findings cost nothing; a report prompt is roughly the size of its findings JSON (a few thousand tokens) with a short structured response, generated at `AI_REPORT_EFFORT=medium`.

**News source hierarchy.** `runNewsScan` reads enabled `news_sources` feeds (dealership → manufacturer → rss), then search providers, then blog/news pages from the latest crawl (`source_type = crawl`; first sighting stored as a reviewed baseline). `scoreSourcedArticle()` applies per-source rules; candidates are ordered by `source_priority` before de-duplication, so the most authoritative copy of a story is stored.
