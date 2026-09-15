# A3 SEO & News Monitor

A production web application that automatically monitors A3 dealership websites for SEO problems, tracks dealership and automotive news, keeps history, detects meaningful changes, and emails summaries and critical alerts. It is designed to be deployed on **Vercel** with a managed **PostgreSQL** database, so no computer needs to stay on.

- **Dealership management** — add/edit/remove dealerships (name, website, brand, dealer group, location, contacts, SEO/news toggles, schedule override). New dealerships are scanned automatically; no code changes.
- **SEO monitoring** — polite, robots.txt-respecting crawler that checks 39 rules: HTTP status, HTTPS, titles, meta descriptions, H1/H2, canonicals, robots.txt, XML sitemaps, indexability, internal/external/broken links, image alt text, duplicate titles/descriptions, structured data, Open Graph, key dealership pages, response time, HTML weight, render-blocking scripts, mixed content, client-side redirects.
- **Deterministic scoring** — a rule-based 0–100 score across 7 categories, configurable in one file. No AI is used for scoring; identical input produces an identical score.
- **News monitoring** — a source hierarchy: the dealership's own news feed, manufacturer newsroom feeds, publisher feeds, then Google News RSS / Bing News RSS / optional NewsAPI & GNews, then news pages the crawler already read on the dealership site. De-duplicated by URL, headline and story (the most authoritative copy wins); reviewers mark articles Relevant / Not relevant / Reviewed.
- **Protected pages, handled gracefully** — Cloudflare challenges, 403s and 429s are classified per URL (PROTECTED / ACCESS_DENIED / RATE_LIMITED), shown as "Protected / Unable to analyze", and never counted as SEO problems. A scan with some protected pages is **PARTIAL**, not failed.
- **Dashboard & reports** — portfolio KPIs, sortable dealership table (score, issues, pages, protected pages, news, status), per-dealership report (Overview, SEO issues, Pages, Protected pages, News, Reports, Crawl history).
- **AI-assisted SEO reports** — executive summary and prioritised actions written by Claude from stored crawler findings only; anything not matching the findings is discarded. Cached by input hash, capped per month (default 300), with a deterministic fallback.
- **U.S. crawler workers & crawl-job API** — the dashboard stays on Vercel; crawling runs on a U.S. container worker (Fly.io, Render, Railway, AWS…) that pulls jobs from Postgres. `POST /api/crawl-jobs` queues work machine-to-machine.
- **Change detection & email** — daily/weekly digests only when something meaningful changed, plus immediate alerts for critical problems. Duplicate-proof.
- **Security** — authentication with roles, protected admin routes, server-side validation, rate limiting, SSRF protection, secure cron endpoint.

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the production architecture, the Vercel feasibility analysis, the database schema and capacity figures.

---

## Contents

1. [Architecture at a glance](#1-architecture-at-a-glance)
2. [Project structure](#2-project-structure)
3. [Local development](#3-local-development)
4. [Database setup & migrations](#4-database-setup--migrations)
5. [Deploying to Vercel](#5-deploying-to-vercel)
6. [Scheduling](#6-scheduling)
7. [Email reports & alerts](#7-email-reports--alerts)
8. [SEO scoring rules](#8-seo-scoring-rules)
9. [News monitoring](#9-news-monitoring)
10. [Websites that block the scanner](#10-websites-that-block-the-scanner)
11. [Scaling beyond Vercel Cron (optional worker)](#11-scaling-beyond-vercel-cron-optional-worker)
12. [Environment variables](#12-environment-variables)
13. [Operations & troubleshooting](#13-operations--troubleshooting)
14. [Testing](#14-testing)
15. [Crawl-job API](#15-crawl-job-api)
16. [SEO reports (AI-assisted)](#16-seo-reports-ai-assisted)
17. [Production deployment: Vercel + U.S. crawler worker](#17-production-deployment-vercel--us-crawler-worker)

---

## 1. Architecture at a glance

| Layer | Technology | Runs on |
|---|---|---|
| Frontend + backend | Next.js 16 (App Router, server components, server actions), TypeScript, Tailwind CSS | Vercel |
| Database | PostgreSQL via Drizzle ORM + postgres.js | Neon / Supabase / RDS / any managed Postgres |
| Scheduler | Vercel Cron → `/api/cron/tick` every 10 minutes (GitHub Actions alternative for Hobby) | Vercel / GitHub |
| Background jobs | Postgres job queue (`SKIP LOCKED`), resumable scans | Vercel Functions (optionally a container worker) |
| SEO crawler | `fetch` + cheerio (no browser), SSRF-guarded | Vercel Functions |
| Performance metrics | Google PageSpeed Insights API (optional) | Google |
| Crawler | Regional crawler workers (US-East / US-Central / US-West), or Vercel Cron in US-East | Fly.io / Railway / Render (worker) or Vercel |
| Protected sites | Classified per URL (PROTECTED / ACCESS_DENIED / RATE_LIMITED), shown as "Protected / Unable to analyze", scans marked PARTIAL; optional alternative source: Google PageSpeed Insights | Google |
| Reports | Deterministic findings + Claude summary (`@anthropic-ai/sdk`), cached and capped monthly | Anthropic API |
| News | Google News RSS, Bing News RSS, NewsAPI, GNews | Vercel Functions |
| Email | Resend API (or any SMTP) | Resend |
| Auth | Email + password (bcrypt), DB-backed sessions, admin/viewer roles | Vercel |

**Why this works on Vercel:** a full website crawl does not fit in one serverless invocation, so every scan is a persisted state machine. Each cron tick crawls for up to ~4 minutes, saves progress to Postgres and exits; the next tick resumes. Chromium is never run on Vercel. JavaScript-rendered performance data comes from Google's hosted Lighthouse. Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## 2. Project structure

```
├── drizzle/                     SQL migrations (generated by drizzle-kit, applied by scripts/migrate.ts)
├── docs/
│   ├── ARCHITECTURE.md          production architecture, schema, capacity, security
│   └── github-actions-scheduler.yml   cron alternative for Vercel Hobby
├── scripts/
│   ├── migrate.ts               apply migrations (runs during Vercel build)
│   ├── create-admin.ts          create/reset a user from the CLI
│   ├── run-tick.ts              process jobs locally without cron
│   └── load-env.ts
├── worker/                      optional always-on worker (same code, same queue) + Dockerfile
├── tests/                       unit tests (scoring determinism, SSRF, parser, news relevance, diffing)
├── vercel.json                  build command + cron schedule
└── src/
    ├── proxy.ts                 route protection + security headers (Next.js 16 "proxy")
    ├── app/
    │   ├── login/               sign-in page
    │   ├── (app)/               authenticated UI
    │   │   ├── page.tsx         dashboard
    │   │   ├── dealerships/[id] dealership report (overview / issues / pages / news / history)
    │   │   ├── news/            news review across dealerships
    │   │   ├── account/         change password
    │   │   └── admin/           dealerships, settings, users, system (admins only)
    │   ├── actions/             server actions (validated, authorised)
    │   └── api/
    │       ├── cron/tick/       scheduler heartbeat (CRON_SECRET)
    │       └── health/          uptime probe
    ├── components/              UI primitives, charts, forms, tables
    └── lib/
        ├── env.ts               validated env access (server-only)
        ├── db/                  schema + client
        ├── auth/                passwords, sessions, guards, login action
        ├── security/            SSRF guard, rate limiter, sanitisation
        ├── seo/                 fetcher, robots, sitemap, parser, scan engine, checks/config (rules), scoring,
        │                        block detection, crawl policy, scan outcomes, PageSpeed integration
        ├── crawler/             crawler regions + worker heartbeats
        ├── news/                providers (RSS/APIs), query builder, relevance rules, monitor
        ├── email/               provider abstraction, templates, digests & alerts
        ├── changes/             fingerprint diffing, alert creation
        ├── jobs/                queue, scheduler, runner, maintenance, after()-kick
        ├── dealerships/         dealership service (validation, keywords)
        └── queries/             read models for pages
```

## 3. Local development

Requirements: **Node.js 20.9+** (22 LTS recommended) and **PostgreSQL 14+** (Postgres.app, Docker, or a free Neon database).

```bash
git clone <repo> a3-seo-monitor && cd a3-seo-monitor
npm install

# 1. Configure
cp .env.example .env.local
#   set DATABASE_URL, and generate secrets:
#   AUTH_SECRET=$(openssl rand -base64 32)   CRON_SECRET=$(openssl rand -base64 32)
#   keep EMAIL_PROVIDER=console locally to print emails to the terminal

# 2. Create the database schema
createdb a3_seo_monitor           # or use Docker / Neon
npm run db:migrate

# 3. Create your admin account
npm run user:create -- --email you@a3brands.com --name "Your Name" --role admin
#   (prints a temporary password; add --password "…" to choose one)

# 4. Run the app
npm run dev                       # http://localhost:3000
```

**Background processing locally.** Manual actions ("Add dealership", "Scan now", "Check news now") start processing automatically. For the scheduler to run on its own, use one of:

```bash
npm run crawler                   # the crawler worker: scheduler + job processing (same as `npm run worker`; Ctrl+C to stop)
npm run scan:once                 # one tick
npm run scan:once -- --until-idle # keep ticking until the queue is empty
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick   # same as Vercel Cron
```

To crawl sites that serve a JavaScript challenge, run the worker with a browser: `npx playwright install chromium` once (or set `BROWSER_CHANNEL=chrome`), then `BROWSER_RENDERING=fallback npm run crawler`. The worker prints developer progress lines such as `[Crawler] Sitemap discovered: 243 URLs; 30 queued` and `[Crawler] Protected: /service/example (Cloudflare bot protection returned a challenge page)`.

Useful commands: `npm run typecheck`, `npm run lint`, `npm test`, `npm run db:studio` (browse the database), `npm run news:rescore` (re-apply news rules to stored articles; add `-- --apply` to save), `npm run news:enrich` (fill in exact publication times, descriptions and direct links for stored articles from publishers' news sitemaps and article pages — robots.txt respected, Google News links never followed; news checks do this automatically).

## 4. Database setup & migrations

* Schema source of truth: `src/lib/db/schema.ts`. SQL migrations live in `drizzle/` and are committed.
* **Apply migrations:** `npm run db:migrate` (uses `DATABASE_URL_UNPOOLED` if set, else `DATABASE_URL`). On Vercel this runs automatically in the build (`npm run vercel-build`). Set `SKIP_DB_MIGRATE=1` to skip it, for example on preview deployments that share the production database.
* **Change the schema:** edit `schema.ts` → `npm run db:generate -- --name describe_change` → review the SQL in `drizzle/` → commit → deploy.
* Recommended providers: **Neon** (serverless-friendly; use the `-pooler` host for `DATABASE_URL` and the direct host for `DATABASE_URL_UNPOOLED`), Supabase (transaction pooler on port 6543), AWS RDS + RDS Proxy.

## 5. Deploying to Vercel

1. **Create a Postgres database** (e.g. Neon → new project). Copy the pooled and direct connection strings.
2. **Push the repository** to GitHub/GitLab/Bitbucket and **import it in Vercel** (framework: Next.js; the build command comes from `vercel.json`).
3. **Set environment variables** in Vercel → Project → Settings → Environment Variables (Production, and Preview if used). At minimum:
   * `DATABASE_URL`, `DATABASE_URL_UNPOOLED`
   * `APP_URL` (e.g. `https://seo.a3brands.com`), `APP_TIMEZONE`
   * `AUTH_SECRET`, `CRON_SECRET` (each `openssl rand -base64 32`)
   * `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`, `EMAIL_FROM`
   * crawler: `CRAWLER_MODE=worker` with a U.S. worker deployed (recommended; see [section 17](#17-production-deployment-vercel--us-crawler-worker)), or `vercel` without one; `DEFAULT_CRAWLER_REGION` (default `us-east`)
   * reports: `ANTHROPIC_API_KEY` (optional — without it reports are composed deterministically), `AI_REPORTS_MONTHLY_LIMIT` (default 300)
   * API: `CRAWLER_API_TOKEN` (optional — enables `POST /api/crawl-jobs`)
   * optional: `PAGESPEED_API_KEY`, `NEWSAPI_KEY`, `GNEWS_API_KEY`, `NEWS_PROVIDERS`
4. **Deploy.** The build applies database migrations, then builds the app.
5. **Create the first admin** from your machine, against the production database:
   ```bash
   DATABASE_URL="<production direct url>" AUTH_SECRET=x CRON_SECRET=xxxxxxxxxxxxxxxx \
     npm run user:create -- --email you@a3brands.com --name "Your Name" --role admin
   ```
   (Password hashing does not use AUTH_SECRET; placeholder values are fine for this command.)
6. **Verify scheduling:** Vercel → Project → Settings → Cron Jobs should list `/api/cron/tick`. Vercel sends `Authorization: Bearer $CRON_SECRET` automatically. On the **Hobby** plan see [Scheduling](#6-scheduling).
7. **Configure email:** in Resend, verify your sending domain (DNS records) and use an address on it for `EMAIL_FROM`. Then use Admin → Settings → "Send test email".
8. Sign in, add dealerships, and set schedules and recipients in **Admin → Settings**.

Health check: `GET /api/health` returns `{ ok: true, database: "up" }`. Use it with any uptime monitor.

## 6. Scheduling

Everything time-based is driven by one heartbeat, `GET /api/cron/tick`, protected by `CRON_SECRET`. On each tick the app:

1. **Schedules** due work: SEO scans for dealerships whose last scan is older than their interval (global setting: every 6 h / 12 h / daily / every 2 days / weekly, or a per-dealership override), news checks (every 3–24 h), the daily digest at the configured hour, the weekly digest on the configured weekday, and daily maintenance.
2. **Processes** queued jobs for up to `CRON_TICK_BUDGET_SECONDS` (default 240 s; the route's `maxDuration` is 300 s), running `JOB_CONCURRENCY` jobs in parallel. Long scans save progress and continue on the next tick.

| Plan | Setup |
|---|---|
| Vercel **Pro / Enterprise** | Nothing to do. `vercel.json` runs the tick every 10 minutes. |
| Vercel **Hobby** | Hobby cron jobs run at most once per day, and a more frequent schedule fails the deployment. Change `vercel.json`'s schedule to `"0 11 * * *"` (or remove the `crons` block), then copy `docs/github-actions-scheduler.yml` to `.github/workflows/` and add the `APP_URL` and `CRON_SECRET` repository secrets. Any HTTP scheduler (cron-job.org, Cloud Scheduler, EasyCron) works the same way: `GET` the endpoint with the Bearer header. |

Pausing: Admin → Settings → "Pause all scheduled scanning". Manual scans still work.
Overlapping ticks are safe: scans, jobs, digests and emails are all de-duplicated in the database.

## 7. Email reports & alerts

* **Daily summary** ("Daily SEO & News Monitoring Report") — one email per recipient listing their dealerships: SEO score (with change), critical issues, warnings, new critical/warnings, resolved issues, new relevant news with headlines, top 3 issues, important changes, and a **View Dashboard** button. Dealerships without changes are listed compactly at the end.
* **Weekly SEO newsletter** (on by default, Mondays 7 AM; Settings → Email reports) — leads with **This week in SEO**, the week's top 8 stories from the SEO news feeds (see [SEO industry news](#seo-industry-news)), followed by every dealership's week in the same format as the daily summary. It is sent every week while there is SEO news, even when no dealership changed. It goes to management recipients, dealership contacts, and **newsletter-only recipients** (who get nothing else). Settings → Email delivery → "Send newsletter preview to me" sends the current week's edition immediately.
* **Daily summaries are only sent when something meaningful changed** for at least one of the recipient's dealerships: new or resolved issues, a score change ≥ the threshold (default 8 points), new relevant news, the website becoming unavailable, or other alerts. Enable "Send summaries even when nothing changed" to always send.
* **Immediate alerts** for critical events (website unavailable, new critical SEO issues), on by default, can be turned off globally or per dealership.
* **Recipients** = each dealership's notification emails + the management recipients from Settings (who receive everything).
* **No duplicates**: each email has a unique key recorded before sending; retries and overlapping ticks skip already-sent emails. The Admin → System page shows the full email log.
* **Provider**: `EMAIL_PROVIDER=resend` (HTTPS API, recommended on Vercel) or `smtp` (Google Workspace, SES, Postmark…). `console` prints emails to the log for development.

## 8. SEO scoring rules

All rules, weights and thresholds are in **`src/lib/seo/checks/config.ts`**:

* `CATEGORIES` — category weights (Technical 20, Metadata 20, Content 15, Links 15, Images 10, Structured data 10, Crawlability 10).
* `CHECKS` — each rule's category, severity (critical / warning / notice), points and recommended action.
* `DEDUCTION_TIERS` — how much of a page-level rule's points are deducted by share of pages affected.
* `THRESHOLDS` — title/description lengths, slow response time, thin-content words, significant score change, and similar.
* `UNVERIFIABLE_LINK_HOSTS` — external domains whose bot protection makes link checks unreliable.

Score = weighted mean of category scores; category score = `100 × (1 − deducted / applicable points)`. Rules with no applicable pages are excluded. After editing, run `npm test` (includes determinism tests). New scans use the new rules; historical scores are unchanged.

Status bands: **85–100 Good**, **65–84 Needs improvement**, **below 65 Poor**. A scan where the site was down or the scanner was blocked shows "not scored" rather than a misleading number.

## 9. News monitoring

* **Source hierarchy** (most authoritative first; `src/lib/news/source-rules.ts`):

  | # | Source | Added in | Kept when |
  |---|---|---|---|
  | 1 | Official dealership news/blog feed | Edit dealership → News sources | always (it is the store's own news) |
  | 2 | Manufacturer newsroom feed | Edit dealership → News sources (optionally shared by every dealership of the brand) | always, as brand context |
  | 3 | Other publisher RSS/Atom feed | Edit dealership → News sources | it mentions the dealership, group, keywords or brand |
  | 4 | News search: Google News RSS, Bing News RSS, NewsAPI, GNews | `NEWS_PROVIDERS` | it mentions the dealership, group, keywords or brand |
  | 5 | News/blog pages on the dealership website | read from the latest crawl — no extra requests to the site | always; the first ones found are a baseline, not "new" |

  When the same story comes from several sources, the most authoritative copy is kept. Feeds are standard RSS/Atom URLs; the monitor does not scrape social networks.
* For each dealership the app builds up to 8 search queries: the exact dealership name, dealer group, custom keywords, `<brand> recall`, new models, manufacturer announcements/awards, and local dealership news for the city.
* Sources: `google_rss` and `bing_rss` (public RSS feeds, no key, not scraping of search-result pages), plus `newsapi` and `gnews` when API keys are set. Choose with `NEWS_PROVIDERS`. Note that NewsAPI's free tier is licensed for development only.
* **Duplicates are removed automatically:** identical URLs (unique per dealership), identical headlines (45 days), and **near-duplicate stories**: syndicated coverage of the same event from many outlets, detected by word overlap of normalised headlines (numbers such as "149K" / "149,000" are normalised). The most relevant, most recent copy is kept.
* Each article stores headline, source, URL, publication date, detected date, matched keywords, topics and a **deterministic relevance score** (rules in `src/lib/news/config.ts`: dealership name +60, dealer group +40, custom keyword +35, brand +15, city +15, plus the strongest topic, e.g. recall +25, award/community/announcement +15). Obituaries and similar pages are excluded even when a name matches.
* **Brand-level context** (stories that match only the brand, such as a nationwide recall) is kept but capped at 8 new stories per check, so dealership-specific news is not drowned out. It scores below the default alert threshold. To include brand recalls in "new relevant news", lower the threshold in Settings to 40.
* Articles at or above the relevance threshold (Settings, default 50) count as "new relevant news" in reports. Reviewers can mark any article **Relevant**, **Not relevant** or **Reviewed** from the News page or the dealership report; articles marked Relevant are always included in reports.
* Custom keywords (former names, general managers, sponsorships…) are managed on each dealership's edit page.

### SEO industry news

The **SEO news** page collects articles from leading SEO publications — Google Search Central Blog, Bing Webmaster Blog, Search Engine Land, Search Engine Journal, Search Engine Roundtable, Moz, Ahrefs and Semrush by default (Backlinko and Yoast are available but off).

* **Extracted from RSS, not crawled:** only each publication's public RSS/Atom feed is read (headline, link, summary, date). The publishers' websites are never crawled; readers follow the headline to the original article. All default feeds were verified to serve the `A3SEOMonitor` User-Agent from cloud IPs, so this runs on Vercel and does not need the crawler worker.
* Feeds are read portfolio-wide once per news interval (Settings → News checks, default every 6 hours); admins can **Fetch now**, add any RSS/Atom feed (it is test-read before saving), turn feeds off or remove them. Items older than 30 days are ignored when a feed is first added; articles follow the history retention setting.
* Each article gets **deterministic topic tags** (`src/lib/news/seo-topics.ts`, no AI): Google update, Automotive, Local SEO, AI search, Search Console, Technical SEO, Paid search. Weights favour what matters to dealership websites, with a bonus for official search-engine sources and a penalty for webinars/sponsored posts. The newsletter's top stories are the highest-weighted articles of the week, at most three per publication.

## 10. Websites that block the scanner

Dealership websites may restrict automated requests: Cloudflare, Akamai and other bot protection, geographic rules, or IP-reputation filters. **The monitor never attempts to bypass, defeat or circumvent these controls.** It identifies itself honestly (`Mozilla/5.0 (compatible; A3SEOMonitor/1.0; +<APP_URL>/bot)`, with a public [/bot](/bot) page for website operators), honours robots.txt, and when access is refused it records that and stops.

**What happens when a site restricts the crawler**

* The refusal is detected (HTTP 401/403/429 or a challenge page, including Dealer Inspire's branded Cloudflare page; `src/lib/seo/block-detect.ts`).
* The affected URL, HTTP status and reason are recorded, shown under **Access & coverage** and on the Pages tab (filter "Not evaluated").
* **Refusals are never retried.** After 2 consecutive refusals, or any HTTP 429, crawling of that site stops, and the remaining pages are marked **Not evaluated** (`src/lib/seo/crawl-policy.ts`).
* Pages that could not be accessed are **never reported as SEO problems** and never counted as "resolved". Blocked or partially blocked scans are not used as change-detection baselines.
* Other dealerships keep scanning normally.
* Sites whose recent scans were blocked are rescanned less often (interval × 2, × 4, … up to a week) so the monitor doesn't keep knocking.
* The scan is marked **Blocked** (requires review) or **Partially blocked**, and admins are notified once when it starts.

**Alternative data sources.** When direct crawling isn't possible, the monitor uses clearly-labelled permitted public sources instead of guessing. Currently that's **Google PageSpeed Insights** (a public Google API, enabled by `PAGESPEED_API_KEY`), which reports the homepage's title, meta description, indexability, canonical, image alt text, HTTPS and performance. Results are marked "Alternative source: Google PageSpeed Insights / limited data", and no full-site score is given. Sitemaps and robots.txt are only used when the site itself serves them to the crawler — though when browser rendering is on and a sitemap request is refused, it is retried once through the browser (see below) so a *blocked* sitemap is not reported as a *missing* one.

**Real-browser rendering (optional).** Some websites serve a JavaScript challenge instead of HTML to plain HTTP clients. With `BROWSER_RENDERING=fallback` the crawler re-requests a *refused* page using Chromium (Playwright), which runs that JavaScript. This is **not** a bypass of the site's security controls:

* the crawler keeps its honest `A3SEOMonitor` User-Agent — it never pretends to be a person's browser;
* robots.txt is still applied before any URL is requested;
* no stealth, fingerprint-spoofing or challenge-solving patches are used;
* if the site still refuses, the refusal is recorded and the pages are reported as "not evaluated", exactly as before.

Chromium cannot run on Vercel functions, so this only happens where a browser exists: the standalone worker (`worker/Dockerfile` installs Chromium onto a slim Node image — build it with `docker build -f worker/Dockerfile -t a3-seo-worker .`) or local development (`npx playwright install chromium`, or `BROWSER_CHANNEL=chrome` to use an installed browser). Pages read this way are stored with `scan_pages.fetch_method = 'browser'`.

Browser work is bounded so a worker cannot exhaust its memory: `BROWSER_MAX_CONCURRENCY` caps how many pages are open at once (separately from `JOB_CONCURRENCY`, since a page costs far more than an HTTP request), and `BROWSER_MAX_CONTEXTS` caps how many per-host sessions are kept, closing the least recently used idle one beyond that. Plan for roughly 1 GB of RAM.

Per dealership, **Page fetching** (Advanced) selects `auto` (follow the global setting), `never` (plain requests only) or `always` (render every page — for sites that serve nothing without JavaScript).

Be aware that a rendered page is the *post-JavaScript* DOM, which can differ from the server-delivered HTML that search engines index first. That is why rendering is used only after a plain request was refused, and why it is recorded per page rather than applied silently.

Two details worth knowing about rendered pages:

* **Response time** is taken from the document's own network timing, not the browser's wall clock. Rendering includes browser startup, JavaScript and any challenge wait, so reporting that as the site's response time would flag every rendered page as slow.
* **A refused sitemap is retried from inside the page** (a same-origin request issued by the loaded document). A separate HTTP client is challenged again even with the right cookies, and Chromium renders XML into a viewer document, so neither a plain request nor a page navigation returns usable sitemap XML.

**How to get full scans of a restricted site:** ask the dealership's website provider (Dealer Inspire, Dealer.com, DealerOn…) to allow-list requests whose User-Agent contains `A3SEOMonitor`. Running the crawler from a US region (see below) also avoids location-based restrictions that apply to non-US traffic.

The crawler reads server-delivered HTML (what search engines index first); content injected only by client-side JavaScript is not seen.

### Scan status

| Status | Meaning |
|---|---|
| **Completed** | Every selected page was evaluated. |
| **Completed with warnings** | Finished, but some pages failed to load (timeouts or server errors) or the site was down. |
| **Partially blocked** (job status **PARTIAL**, dashboard "Partial · pages protected") | The site restricted access to some pages; those pages were not evaluated and are not SEO problems. |
| **Blocked** (job status **PARTIAL**, dashboard "Protected / Unable to analyze") | The site restricted automated access; SEO results were not evaluated. Requires review. |
| **Failed** | The scan could not be completed because of an error. |

Every requested URL also gets a result class, stored in `scan_pages.result_class` (`src/lib/seo/result-class.ts`): `SUCCESS`, `REDIRECT`, `NOT_FOUND`, `CLIENT_ERROR`, **`PROTECTED`** (a security challenge such as Cloudflare's), **`ACCESS_DENIED`** (401/403), **`RATE_LIMITED`** (429), `SERVER_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, `NOT_EVALUATED` (not requested after the site restricted access) and `SKIPPED`.

The dashboard (Status, **Protected** column and the **Access restricted** count), the dealership report (banner, **Protected pages** tab, Pages → result badges), SEO reports and the email reports always keep *actual SEO problems* apart from *pages that could not be analyzed*.

### Crawl politeness & page priority

* robots.txt respected, including `Crawl-delay`. Robots.txt and sitemaps are cached (12 h / 24 h) so they aren't re-downloaded on every scan.
* One page at a time per website, with a delay between requests (`CRAWLER_DELAY_MS`, default 750 ms), and one active scan per website even when dealerships share a domain. External link checks never send two requests to the same host at once.
* Redirects, 403, 429, 5xx and timeouts are handled explicitly: only timeouts, dropped connections and 5xx are retried, once, with backoff.
* **Sitemap-first:** robots.txt → the dealership's configured **Sitemap URL** (Edit dealership), robots.txt `Sitemap:` entries, `/sitemap.xml`, `/sitemap_index.xml` (indexes and gzip supported) → the sitemap's own URLs → internal links from the homepage only for whatever budget is left (or everything, when there is no readable sitemap).
* A page budget per dealership (**Max pages per scan**, default `CRAWLER_DEFAULT_MAX_PAGES` / `MAX_PAGES_PER_DEALERSHIP`) is spent in priority order: **homepage → new inventory → used inventory → service → parts → finance → about → contact → specials → blog/articles → other SEO/pillar pages**. Vehicle-detail pages are sampled. The order is set by `PAGE_TYPE_PRIORITY` in `src/lib/seo/url.ts`.
* The website platform (Dealer Inspire, Dealer.com, DealerOn…) is recognised from the homepage markup already downloaded and shown on the dealership page — useful when asking a provider to allow-list the crawler.

## 11. Regional crawler workers

Production crawling must not depend on anyone's laptop or location. The crawler runs in the cloud from a **US region**, and additional regions can be added later.

```
Vercel dashboard ─► API / server actions ─► jobs queue (PostgreSQL) ─► Cloud crawler worker (US-East | US-Central | US-West) ─► dealership website
                                                  ▲                                  │
                                                  └──────── SEO results ◄────────────┘ ─► dashboard + email
```

* **Two modes** (`CRAWLER_MODE`):
  * `vercel` (default): Vercel Cron ticks crawl. `vercel.json` pins functions to **iad1 (US-East, Washington D.C.)**, so crawling happens from the US.
  * `worker` (recommended for production): Vercel never crawls. It serves the dashboard and handles news, emails and scheduling, while dedicated crawler workers crawl. The dashboard keeps working when crawlers are busy, restarting or offline, because the two only share the database.
* **Regions:** US-East, US-Central and US-West are built in (`src/lib/crawler/regions.ts`); add more with `CRAWLER_EXTRA_REGIONS="eu-west:EU-West"`. Each dealership has a **Preferred crawler region** (Edit dealership). Leave it on *Default* to use `DEFAULT_CRAWLER_REGION` (US-East).
* **Routing:** scan jobs carry their region, and a worker only picks up jobs for its `WORKER_REGION`. Workers report a heartbeat, and **Admin → System → Crawler regions** shows which regions are online and how many scans are waiting. If a region has no crawler online for 30 minutes, its queued scans move to the default region (noted in the scan log).
* **Running a worker** (same code and queue as the app, Docker image in `worker/Dockerfile`):
  ```bash
  # Fly.io, one app per region (template: deploy/fly.toml)
  fly launch --copy-config --config deploy/fly.toml --name a3-crawler-us-east --region iad --no-deploy
  fly secrets set DATABASE_URL=... AUTH_SECRET=... CRON_SECRET=... APP_URL=... PAGESPEED_API_KEY=... -a a3-crawler-us-east
  fly deploy --config deploy/fly.toml -a a3-crawler-us-east
  # US-Central: --region ord (or dfw), WORKER_REGION=us-central · US-West: --region sjc (or lax), WORKER_REGION=us-west
  ```
  Railway (us-east4 / us-west2) and Render (Virginia / Ohio / Oregon) work the same way: deploy `worker/Dockerfile` with `WORKER_REGION` and the app's environment variables. `WORKER_JOB_TYPES=seo_scan` makes a crawl-only worker. Then set `CRAWLER_MODE=worker` on Vercel.
* **Capacity:** each worker processes `JOB_CONCURRENCY` scans in parallel (different websites; the same site is never crawled in parallel). Add workers or replicas per region as the portfolio grows; `SKIP LOCKED` guarantees each job runs once.

## 12. Environment variables

See **`.env.example`** for the full, commented list. Required: `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `APP_URL`. Everything else has safe defaults or enables an optional integration. Secrets are only read on the server (`src/lib/env.ts` is `server-only` and validated at startup), and nothing is exposed to the browser.

## 13. Operations & troubleshooting

* **Admin → System** shows queued/running/failed jobs (with Retry), scan failures, the email log, persisted warnings/errors, and which integrations are active. "Process queue now" runs a tick immediately.
* *Jobs queued but nothing runs* → the cron isn't calling the app: check Vercel Cron Jobs (or your GitHub Action), and make sure `CRON_SECRET` matches. The System page warns when this happens.
* *A dealership shows "Scan blocked"* → see [section 10](#10-websites-that-block-the-scanner).
* *Website down alerts* are only sent when the homepage cannot be loaded (DNS, connection, timeouts, 5xx or 404/410), and only when availability changes.
* *Emails not arriving* → Settings → Send test email; check the System email log for the provider's error; verify the sending domain in Resend.
* Storage is bounded by daily maintenance: page-level details for the 10 most recent scans per dealership, and score history, reports and news for `retentionDays` (Settings).
* Logs: structured JSON in Vercel's function logs. Warnings and errors are also stored in `system_logs`.

## 14. Testing

```bash
npm test            # unit tests: scoring determinism, SSRF guard, URL handling, HTML parser, block detection, render policy, news relevance, change diffing
npm run typecheck
npm run lint
npm run build
```

## 15. Crawl-job API

A token-authenticated, provider-independent way to queue work from other systems. It only writes to the job queue — crawling never happens inside the Vercel request. Enable it by setting `CRAWLER_API_TOKEN`.

```bash
# Queue an SEO scan (jobType: "seo" | "news" | "report"; url is optional and must be the dealership's own site)
curl -X POST "$APP_URL/api/crawl-jobs" \
  -H "Authorization: Bearer $CRAWLER_API_TOKEN" -H "Content-Type: application/json" \
  -d '{"dealershipId": 1, "jobType": "seo", "url": "https://www.bmwfwb.com/"}'
# → 202 {"job": {"id": 68, "jobType": "seo", "status": "QUEUED", …}, "created": true}

# Poll status
curl -H "Authorization: Bearer $CRAWLER_API_TOKEN" "$APP_URL/api/crawl-jobs/68"
# → {"job": {"status": "PARTIAL", "scan": {"score": 91, "pagesAnalyzed": 29, "pagesProtected": 1, …}}}
```

Statuses: `QUEUED`, `RUNNING`, `COMPLETED`, `PARTIAL` (finished, some or all pages protected), `FAILED` (the monitor itself failed). Requests per dealership and job type are rate-limited (6 per hour). If a scan is already running, the existing job is returned with `"created": false`.

## 16. SEO reports (AI-assisted)

Open a dealership → **Reports** → **Generate report**. Reports are produced by the `report` job from the latest completed scan:

1. **Findings are computed by code** (`src/lib/reports/findings.ts`): score and category scores, pages analyzed/protected, every issue with its priority (CRITICAL / HIGH / MEDIUM / LOW, defined per check in `src/lib/seo/priority.ts`), affected pages and sample URLs, passed checks, protected URLs, score changes, PageSpeed metrics and the last 30 days of dealership, manufacturer and industry news.
2. **The AI writes only the narrative** (`src/lib/reports/ai.ts`): Claude (`AI_REPORT_MODEL`, default `claude-opus-5`, structured output) returns an executive summary, prioritised actions that must reference existing findings, and short notes. Refusals are rerouted server-side to Anthropic's recommended fallback model.
3. **Grounding** (`src/lib/reports/ground.ts`) discards actions for checks that are not in the findings, highlights for unknown articles, and any sentence quoting a number the findings do not contain; priorities and affected-page counts always come from the findings. Every CRITICAL/HIGH finding gets an action even if the model skipped it.
4. Sections — Executive summary, Critical issues, SEO issues grouped by area, Protected pages, News monitoring, Recommended actions — are rendered from the findings, so the report cannot show an issue the crawler did not find.

**Cost control for ~300 reports/month:** identical findings reuse the stored narrative (input hash, no model call); each model call reserves a slot under a database lock, so parallel jobs cannot exceed `AI_REPORTS_MONTHLY_LIMIT` (UTC month); when the key is missing or the limit is reached, the same report is composed deterministically and labelled as such. Every call is logged in `report_runs` with token usage. Admins can email a report to the dealership's recipients from the report view.

## 17. Production deployment: Vercel + U.S. crawler worker

```
User (Philippines) → Vercel (Next.js dashboard + API + cron) → Postgres job queue ← U.S. crawler worker (Chromium) → dealership websites
                                   │                                   ▲
                                   └── reports (Anthropic API) ─────────┴── results, protected pages, news → dashboard + email
```

1. **Database:** managed PostgreSQL (Neon, Supabase, RDS). Note the pooled URL (Vercel) and direct URL (migrations).
2. **Vercel:** import the repo, set the variables from [section 5](#5-deploying-to-vercel) with **`CRAWLER_MODE=worker`**, deploy (migrations run in the build).
3. **U.S. worker** — any container host in a U.S. region, using `worker/Dockerfile` (includes Chromium) and the **same** `DATABASE_URL`, `AUTH_SECRET`, `CRON_SECRET`, `APP_URL`, plus `WORKER_REGION=us-east`, `WORKER_JOB_TYPES=seo_scan`, `BROWSER_RENDERING=fallback`:
   * **Fly.io:** `deploy/fly.toml` (commands in [section 11](#11-regional-crawler-workers)).
   * **Render:** New → Blueprint → `deploy/render.yaml` (region `virginia`), then fill in the secret values.
   * **Railway / AWS ECS / Google Cloud Run (always-on) / DigitalOcean:** build `worker/Dockerfile` from the repository root, choose a U.S. region, set the variables above, no inbound port needed.
4. **Verify:** Admin → System → *Crawler regions* shows the worker online; "Scan now" on a dealership shows `[Crawler] …` lines in the worker logs and results on the dashboard within minutes.

The worker needs no public endpoint and holds no state: it can be stopped, moved to another provider or scaled out at any time, and queued scans simply wait in Postgres (or fall back to the default region after 30 minutes).
