import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/* ────────────────────────────── Enums ─────────────────────────────── */

export const userRoleEnum = pgEnum("user_role", ["admin", "viewer"]);
export const scanStatusEnum = pgEnum("scan_status", ["queued", "crawling", "finalizing", "completed", "failed", "cancelled"]);
export const scanTriggerEnum = pgEnum("scan_trigger", ["scheduled", "manual"]);
export const pageStatusEnum = pgEnum("page_status", ["pending", "fetched", "failed", "skipped"]);
export const severityEnum = pgEnum("issue_severity", ["critical", "warning", "info"]);
export const checkStatusEnum = pgEnum("check_status", ["pass", "warn", "fail", "na"]);
export const relevanceEnum = pgEnum("news_relevance", ["new", "relevant", "not_relevant", "reviewed"]);
export const keywordKindEnum = pgEnum("keyword_kind", ["dealership", "group", "brand", "local", "custom"]);
export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "completed", "failed", "cancelled"]);
export const jobTypeEnum = pgEnum("job_type", ["seo_scan", "news_scan", "digest", "alert", "maintenance", "report", "industry_news"]);
export const emailKindEnum = pgEnum("email_kind", ["daily_digest", "weekly_digest", "alert", "test", "report", "password_reset"]);
export const emailStatusEnum = pgEnum("email_status", ["pending", "sent", "failed", "skipped"]);
export const alertTypeEnum = pgEnum("alert_type", [
  "site_unavailable",
  "new_critical_issues",
  "score_drop",
  "score_gain",
  "issues_resolved",
  "site_recovered",
  "new_relevant_news",
  "scan_failed",
]);
export const logLevelEnum = pgEnum("log_level", ["info", "warn", "error"]);
/** What a finished scan was able to evaluate (separate from the job lifecycle `status`). */
export const scanOutcomeEnum = pgEnum("scan_outcome", ["completed", "completed_with_warnings", "partially_blocked", "blocked", "failed"]);

/* ────────────────────────────── Users & auth ───────────────────────── */

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 320 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("viewer"),
    isActive: boolean("is_active").notNull().default(true),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(sql`lower(${t.email})`)],
);

/**
 * One-time links for "forgot password". Only the hash of the token is stored,
 * so the table is useless to anyone who reads it; links expire and are single use.
 */
export const passwordResets = pgTable(
  "password_resets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    requestedIp: varchar("requested_ip", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("password_resets_token_idx").on(t.tokenHash), index("password_resets_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 128 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    userAgent: varchar("user_agent", { length: 500 }),
    ipAddress: varchar("ip_address", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);

/* ────────────────────────────── Dealerships ────────────────────────── */

/** How a dealership's pages may be fetched. See `dealerships.renderMode`. */
export const RENDER_MODES = ["auto", "never", "always"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

export const dealerships = pgTable(
  "dealerships",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 200 }).notNull(),
    websiteUrl: varchar("website_url", { length: 500 }).notNull(),
    /** Normalised host (lowercase, no "www.") used to group scans and deduplicate. */
    host: varchar("host", { length: 255 }).notNull(),
    brand: varchar("brand", { length: 100 }).notNull(),
    dealerGroup: varchar("dealer_group", { length: 200 }),
    city: varchar("city", { length: 120 }),
    state: varchar("state", { length: 60 }),
    notificationEmails: jsonb("notification_emails").$type<string[]>().notNull().default([]),
    seoEnabled: boolean("seo_enabled").notNull().default(true),
    newsEnabled: boolean("news_enabled").notNull().default(true),
    /** Send immediate emails for critical changes (site down, new critical issues). */
    instantAlertsEnabled: boolean("instant_alerts_enabled").notNull().default(true),
    /** Per-dealership SEO scan interval override in hours (null = global setting). */
    scanIntervalHours: integer("scan_interval_hours"),
    maxPages: integer("max_pages"),
    /** Crawler region this dealership is scanned from (null = default US region). */
    preferredRegion: varchar("preferred_region", { length: 40 }),
    /**
     * Whether a real browser (Chromium) may be used for this website.
     * "auto" follows BROWSER_RENDERING; "never" keeps plain HTTP only;
     * "always" renders every page (for sites that only work with JavaScript).
     */
    renderMode: varchar("render_mode", { length: 20 }).notNull().default("auto").$type<RenderMode>(),
    /** Website platform entered by an admin (e.g. "Dealer Inspire"); wins over the detected one. */
    websitePlatform: varchar("website_platform", { length: 60 }),
    /** Platform recognised from the homepage markup during the last successful homepage read. */
    detectedPlatform: varchar("detected_platform", { length: 60 }),
    /** Sitemap to use first, when the site's sitemap is not at /sitemap.xml or listed in robots.txt. */
    sitemapUrl: varchar("sitemap_url", { length: 500 }),
    /** Last scan that evaluated at least one page (completed or partial). */
    lastSuccessfulScanAt: timestamp("last_successful_scan_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    lastSeoScanId: bigint("last_seo_scan_id", { mode: "number" }),
    lastSeoScanAt: timestamp("last_seo_scan_at", { withTimezone: true }),
    lastNewsScanAt: timestamp("last_news_scan_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dealerships_host_idx").on(t.host), index("dealerships_active_idx").on(t.isActive)],
);

export const newsKeywords = pgTable(
  "news_keywords",
  {
    id: serial("id").primaryKey(),
    dealershipId: integer("dealership_id")
      .notNull()
      .references(() => dealerships.id, { onDelete: "cascade" }),
    keyword: varchar("keyword", { length: 200 }).notNull(),
    kind: keywordKindEnum("kind").notNull().default("custom"),
    isEnabled: boolean("is_enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("news_keywords_dealership_idx").on(t.dealershipId),
    uniqueIndex("news_keywords_unique_idx").on(t.dealershipId, sql`lower(${t.keyword})`),
  ],
);

/* ────────────────────────────── SEO scans ──────────────────────────── */

export type CategoryScores = Record<string, { score: number; max: number }>;

/** Outcome of requesting one URL. Protection and refusals are recorded, never treated as SEO problems. */
export const PAGE_RESULT_CLASSES = [
  "SUCCESS",
  "REDIRECT",
  "NOT_FOUND",
  "CLIENT_ERROR",
  "PROTECTED",
  "ACCESS_DENIED",
  "RATE_LIMITED",
  "SERVER_ERROR",
  "TIMEOUT",
  "NETWORK_ERROR",
  "NOT_EVALUATED",
  "SKIPPED",
] as const;
export type PageResultClass = (typeof PAGE_RESULT_CLASSES)[number];

export interface ScanChangeSummary {
  previousScanId: number | null;
  previousScore: number | null;
  scoreDelta: number | null;
  newIssues: Array<{ fingerprint: string; checkKey: string; severity: string; url: string; message: string }>;
  resolvedIssues: Array<{ fingerprint: string; checkKey: string; severity: string; url: string; message: string }>;
  newCriticalCount: number;
  newWarningCount: number;
  resolvedCount: number;
  availabilityChanged: boolean;
  siteAvailable: boolean;
}

/** Limited homepage check done from Google's servers when direct access is blocked. */
export interface RemoteAuditResult {
  provider: "pagespeed";
  url: string;
  finalUrl: string;
  error?: string | null;
  statusOk: boolean | null;
  titleOk: boolean | null;
  descriptionOk: boolean | null;
  crawlable: boolean | null;
  canonical: "ok" | "missing" | "invalid" | null;
  imagesMissingAlt: number | null;
  viewportOk: boolean | null;
  https: boolean;
  seoScore: number | null;
  performance: { performance: number | null; lcpMs: number | null; cls: number | null; tbtMs: number | null; fcpMs: number | null; strategy: string; error?: string } | null;
}

export interface CrawlState {
  phase: "init" | "crawl" | "links" | "finalize";
  baseUrl: string;
  robotsFound: boolean;
  robotsContent: string | null;
  robotsBlocksMonitor: boolean;
  crawlDelayMs: number;
  robotsBlockedCount: number;
  sitemapUrlsSeeded: number;
  crawlBlocked?: boolean;
  homepageErrorCode?: string | null;
  homepageStatus?: number | null;
  /** Link ids selected (deterministically) for status checking. */
  linkQueue?: number[];
  /** Internal links the plain client was refused on, to re-check through the browser session. */
  browserLinkQueue?: number[];
  /** Consecutive steps where browser link checks ran out of time before checking anything. */
  browserLinkStalls?: number;
  /** Pages requested so far (developer progress logs). */
  pagesRequested?: number;
  /** The site refused a plain request in this scan and served a real browser, so later pages go straight to the browser. */
  siteRefusesPlain?: boolean;
  linksPrepared?: boolean;
  blockedReason?: "robots" | "firewall" | null;
  blockVendor?: string | null;
  /** Consecutive blocked responses; crawling this site stops when it reaches the policy limit. */
  blockStreak?: number;
  /** Set when crawling was stopped because the site restricted access. */
  stoppedForBlock?: { url: string; status: number | null; reason: string } | null;
  /** True when at least one page had to be rendered with a real browser after a plain request was refused. */
  renderedWithBrowser?: boolean;
  remoteAudit?: RemoteAuditResult | null;
}

export interface PageDetails {
  imagesMissingAltSamples?: string[];
  imagesWithoutDimensions?: number;
  mixedContentCount?: number;
  redirectChain?: string[];
  twitterCard?: boolean;
  truncated?: boolean;
  clientRedirect?: { type: "meta" | "script"; target: string } | null;
}

export interface SiteChecksSummary {
  robotsTxt: { found: boolean; url: string; blocksAll: boolean; blocksGooglebot: boolean; blocksMonitor: boolean; sitemaps: string[]; error?: string; blocked?: boolean };
  sitemap: { found: boolean; url: string | null; urlCount: number; error?: string; blocked?: boolean };
  homepageStatus: number | null;
  homepageHttps: boolean;
  importantPages: Array<{ key: string; label: string; found: boolean; url: string | null }>;
  brokenInternalLinks: number;
  brokenExternalLinks: number;
  linksChecked: number;
  duplicateTitles: number;
  duplicateDescriptions: number;
  avgResponseMs: number | null;
  pagesFailed?: number;
  robotsBlockedCount?: number;
  crawlBlocked?: boolean;
  blockedReason?: "robots" | "firewall" | null;
  blockVendor?: string | null;
  /** Where the data came from: our crawler, or a clearly-labelled alternative source. */
  dataSource?: "direct" | "google_pagespeed" | "none";
  /** URLs the website refused (HTTP status + reason), for QA review. */
  blockedUrls?: Array<{ url: string; status: number | null; reason: string }>;
  pagesNotEvaluated?: number;
  crawledFrom?: { region: string; crawlerId: string } | null;
  /** full = site crawled; remote = only a limited homepage check via Google; none = nothing could be checked. */
  auditMode?: "full" | "remote" | "none";
  remoteAudit?: RemoteAuditResult | null;
  pagespeed?: { performance: number | null; lcpMs: number | null; cls: number | null; tbtMs: number | null; fcpMs: number | null; strategy: string; error?: string } | null;
}

export const seoScans = pgTable(
  "seo_scans",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dealershipId: integer("dealership_id")
      .notNull()
      .references(() => dealerships.id, { onDelete: "cascade" }),
    status: scanStatusEnum("status").notNull().default("queued"),
    outcome: scanOutcomeEnum("outcome"),
    trigger: scanTriggerEnum("trigger").notNull().default("scheduled"),
    /** Website address scanned. Scans are only compared with scans of the same website. */
    websiteUrl: varchar("website_url", { length: 500 }),
    /** Region requested for this scan, and the crawler that actually ran it. */
    region: varchar("region", { length: 40 }),
    crawlerId: varchar("crawler_id", { length: 120 }),
    pagesBlocked: integer("pages_blocked").notNull().default(0),
    pagesNotEvaluated: integer("pages_not_evaluated").notNull().default(0),
    maxPages: integer("max_pages").notNull().default(40),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    pagesScanned: integer("pages_scanned").notNull().default(0),
    pagesFailed: integer("pages_failed").notNull().default(0),
    score: integer("score"),
    categoryScores: jsonb("category_scores").$type<CategoryScores>(),
    criticalCount: integer("critical_count").notNull().default(0),
    warningCount: integer("warning_count").notNull().default(0),
    passedCount: integer("passed_count").notNull().default(0),
    siteChecks: jsonb("site_checks").$type<SiteChecksSummary>(),
    changeSummary: jsonb("change_summary").$type<ScanChangeSummary>(),
    /** Compact "<severity char><fingerprint>" list of every issue, kept long-term for digest diffs. */
    issueFingerprints: jsonb("issue_fingerprints").$type<string[]>(),
    infoCount: integer("info_count").notNull().default(0),
    previousScanId: bigint("previous_scan_id", { mode: "number" }),
    errorMessage: text("error_message"),
    siteAvailable: boolean("site_available"),
    /** Whether page-level detail rows are still retained (pruned by maintenance). */
    detailsRetained: boolean("details_retained").notNull().default(true),
    /** Resumable crawl state (phase, robots.txt, sitemap) so a scan can span several short invocations. */
    crawlState: jsonb("crawl_state").$type<CrawlState>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("seo_scans_dealership_idx").on(t.dealershipId, t.createdAt),
    index("seo_scans_status_idx").on(t.status),
    // Only one in-flight scan per dealership at a time.
    uniqueIndex("seo_scans_one_active_idx")
      .on(t.dealershipId)
      .where(sql`${t.status} in ('queued', 'crawling', 'finalizing')`),
  ],
);

export const scanPages = pgTable(
  "scan_pages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: bigint("scan_id", { mode: "number" })
      .notNull()
      .references(() => seoScans.id, { onDelete: "cascade" }),
    dealershipId: integer("dealership_id").notNull(),
    url: varchar("url", { length: 2000 }).notNull(),
    normalizedUrl: varchar("normalized_url", { length: 2000 }).notNull(),
    depth: integer("depth").notNull().default(0),
    status: pageStatusEnum("status").notNull().default("pending"),
    pageType: varchar("page_type", { length: 40 }),
    isImportant: boolean("is_important").notNull().default(false),
    /** Crawl order: lower first (0 = homepage, 1 = key nav pages, 5 = links, 8 = sitemap). */
    priority: integer("priority").notNull().default(5),
    httpStatus: integer("http_status"),
    finalUrl: varchar("final_url", { length: 2000 }),
    redirected: boolean("redirected").notNull().default(false),
    responseTimeMs: integer("response_time_ms"),
    ttfbMs: integer("ttfb_ms"),
    contentType: varchar("content_type", { length: 120 }),
    /** "http" (plain request) or "browser" (Chromium rendered it after a refusal). */
    fetchMethod: varchar("fetch_method", { length: 10 }).$type<"http" | "browser">(),
    htmlBytes: integer("html_bytes"),
    title: text("title"),
    metaDescription: text("meta_description"),
    h1: jsonb("h1").$type<string[]>(),
    h2: jsonb("h2").$type<string[]>(),
    canonical: text("canonical"),
    robotsMeta: varchar("robots_meta", { length: 200 }),
    xRobotsTag: varchar("x_robots_tag", { length: 200 }),
    indexable: boolean("indexable"),
    lang: varchar("lang", { length: 20 }),
    hasViewport: boolean("has_viewport"),
    wordCount: integer("word_count"),
    internalLinksCount: integer("internal_links_count"),
    externalLinksCount: integer("external_links_count"),
    imagesCount: integer("images_count"),
    imagesMissingAlt: integer("images_missing_alt"),
    scriptsCount: integer("scripts_count"),
    blockingScriptsCount: integer("blocking_scripts_count"),
    stylesheetsCount: integer("stylesheets_count"),
    schemaTypes: jsonb("schema_types").$type<string[]>(),
    schemaErrors: integer("schema_errors"),
    openGraph: jsonb("open_graph").$type<Record<string, string>>(),
    details: jsonb("details").$type<PageDetails>(),
    errorCode: varchar("error_code", { length: 60 }),
    errorMessage: text("error_message"),
    /** What happened when the URL was requested: SUCCESS, REDIRECT, PROTECTED, ACCESS_DENIED, RATE_LIMITED… (see seo/result-class.ts). */
    resultClass: varchar("result_class", { length: 24 }).$type<PageResultClass>(),
    issueCount: integer("issue_count").notNull().default(0),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("scan_pages_scan_url_idx").on(t.scanId, t.normalizedUrl),
    index("scan_pages_scan_status_idx").on(t.scanId, t.status),
    index("scan_pages_scan_result_idx").on(t.scanId, t.resultClass),
  ],
);

/** Unique link targets discovered during a scan, with the result of a status check. */
export const scanLinks = pgTable(
  "scan_links",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: bigint("scan_id", { mode: "number" })
      .notNull()
      .references(() => seoScans.id, { onDelete: "cascade" }),
    url: varchar("url", { length: 2000 }).notNull(),
    isInternal: boolean("is_internal").notNull(),
    httpStatus: integer("http_status"),
    errorCode: varchar("error_code", { length: 60 }),
    checked: boolean("checked").notNull().default(false),
    isBroken: boolean("is_broken").notNull().default(false),
    foundOn: jsonb("found_on").$type<string[]>().notNull().default([]),
    occurrences: integer("occurrences").notNull().default(1),
    anchorText: varchar("anchor_text", { length: 300 }),
  },
  (t) => [uniqueIndex("scan_links_scan_url_idx").on(t.scanId, t.url), index("scan_links_scan_broken_idx").on(t.scanId, t.isBroken)],
);

/** Aggregated result for each check in a scan (the score breakdown). */
export const seoChecks = pgTable(
  "seo_checks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: bigint("scan_id", { mode: "number" })
      .notNull()
      .references(() => seoScans.id, { onDelete: "cascade" }),
    checkKey: varchar("check_key", { length: 80 }).notNull(),
    category: varchar("category", { length: 40 }).notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    status: checkStatusEnum("status").notNull(),
    passCount: integer("pass_count").notNull().default(0),
    warnCount: integer("warn_count").notNull().default(0),
    failCount: integer("fail_count").notNull().default(0),
    pointsDeducted: integer("points_deducted").notNull().default(0),
    maxPoints: integer("max_points").notNull().default(0),
  },
  (t) => [uniqueIndex("seo_checks_scan_key_idx").on(t.scanId, t.checkKey)],
);

export const seoIssues = pgTable(
  "seo_issues",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: bigint("scan_id", { mode: "number" })
      .notNull()
      .references(() => seoScans.id, { onDelete: "cascade" }),
    dealershipId: integer("dealership_id").notNull(),
    pageId: bigint("page_id", { mode: "number" }),
    url: varchar("url", { length: 2000 }).notNull(),
    checkKey: varchar("check_key", { length: 80 }).notNull(),
    category: varchar("category", { length: 40 }).notNull(),
    severity: severityEnum("severity").notNull(),
    message: text("message").notNull(),
    recommendation: text("recommendation").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    /** Stable hash of (checkKey + url) used for change detection between scans. */
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    firstDetectedAt: timestamp("first_detected_at", { withTimezone: true }).notNull().defaultNow(),
    isNew: boolean("is_new").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("seo_issues_scan_idx").on(t.scanId, t.severity),
    index("seo_issues_dealership_idx").on(t.dealershipId, t.createdAt),
    index("seo_issues_fingerprint_idx").on(t.scanId, t.fingerprint),
  ],
);

/** Per-scan event log (scan history / timeline shown to QA). */
export const scanEvents = pgTable(
  "scan_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    scanId: bigint("scan_id", { mode: "number" })
      .notNull()
      .references(() => seoScans.id, { onDelete: "cascade" }),
    level: logLevelEnum("level").notNull().default("info"),
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("scan_events_scan_idx").on(t.scanId, t.createdAt)],
);

/* ────────────────────────────── News ───────────────────────────────── */

export const newsArticles = pgTable(
  "news_articles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dealershipId: integer("dealership_id")
      .notNull()
      .references(() => dealerships.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: varchar("url", { length: 2000 }).notNull(),
    urlHash: varchar("url_hash", { length: 64 }).notNull(),
    titleHash: varchar("title_hash", { length: 64 }).notNull(),
    source: varchar("source", { length: 200 }),
    provider: varchar("provider", { length: 40 }).notNull(),
    summary: text("summary"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    /**
     * "datetime" when the source gave a real publication time; "date" when only the day is known
     * (Google News reports date-only stories at a placeholder hour). Null when there is no publication date.
     */
    publishedPrecision: varchar("published_precision", { length: 10 }).$type<"datetime" | "date">(),
    /** The publisher's website as named by an aggregator (Google News), used to find the article in the publisher's news sitemap. */
    publisherUrl: varchar("publisher_url", { length: 500 }),
    /** Direct link to the article on the publisher's site, when `url` is an aggregator link. */
    originalUrl: varchar("original_url", { length: 2000 }),
    /** When the publisher's own article page was read for its exact publication time and description (attempted once). */
    enrichedAt: timestamp("enriched_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    matchedKeywords: jsonb("matched_keywords").$type<string[]>().notNull().default([]),
    topics: jsonb("topics").$type<string[]>().notNull().default([]),
    /** Deterministic relevance score 0-100 from keyword matching (not AI). */
    relevanceScore: integer("relevance_score").notNull().default(0),
    /**
     * "dealership" — about this store; counted on the dashboard and eligible for alerts.
     * "brand" — manufacturer-level context matched on the brand alone; shown separately, never counted.
     */
    scope: varchar("scope", { length: 20 }).$type<"dealership" | "brand">().notNull().default("brand"),
    relevance: relevanceEnum("relevance").notNull().default("new"),
    /** Where the article came from, in trust order (see news/sources.ts): dealership, manufacturer, rss, search, crawl. */
    sourceType: varchar("source_type", { length: 20 }).$type<NewsSourceType>().notNull().default("search"),
    /** 1 = most authoritative (official dealership news) … 5 = least (discovered by crawling). */
    sourcePriority: integer("source_priority").notNull().default(4),
    /** The configured feed/page it came from, when not a search provider. */
    newsSourceId: integer("news_source_id").references(() => newsSources.id, { onDelete: "set null" }),
    reviewedBy: integer("reviewed_by"),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("news_articles_dealer_url_idx").on(t.dealershipId, t.urlHash),
    index("news_articles_dealer_title_idx").on(t.dealershipId, t.titleHash),
    index("news_articles_dealer_detected_idx").on(t.dealershipId, t.detectedAt),
    index("news_articles_relevance_idx").on(t.relevance, t.detectedAt),
    index("news_articles_dealer_scope_idx").on(t.dealershipId, t.scope, t.relevance),
  ],
);

/**
 * Legitimate news sources configured per dealership, or per brand for manufacturer
 * newsrooms (dealership_id null). Search providers (Google/Bing News RSS, APIs) are
 * not rows here — they are the fallback tier after these.
 */
export type NewsSourceType = "dealership" | "manufacturer" | "rss" | "search" | "crawl";
export const newsSources = pgTable(
  "news_sources",
  {
    id: serial("id").primaryKey(),
    /** null = applies to every dealership of `brand` (manufacturer newsroom feeds). */
    dealershipId: integer("dealership_id").references(() => dealerships.id, { onDelete: "cascade" }),
    brand: varchar("brand", { length: 100 }),
    /** "dealership" (the store's own news/blog feed), "manufacturer" (OEM newsroom) or "rss" (any other publisher feed). */
    sourceType: varchar("source_type", { length: 20 }).$type<"dealership" | "manufacturer" | "rss">().notNull(),
    label: varchar("label", { length: 200 }).notNull(),
    /** An RSS/Atom feed URL. */
    url: varchar("url", { length: 1000 }).notNull(),
    isEnabled: boolean("is_enabled").notNull().default(true),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    lastStatus: varchar("last_status", { length: 20 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("news_sources_dealership_idx").on(t.dealershipId),
    index("news_sources_brand_idx").on(sql`lower(${t.brand})`),
    uniqueIndex("news_sources_unique_idx").on(sql`coalesce(${t.dealershipId}, 0)`, sql`lower(${t.url})`),
  ],
);

/* ────────────────────────────── SEO industry news ──────────────────── */

/**
 * RSS/Atom feeds of SEO publications (Search Engine Land, Google Search Central…).
 * Portfolio-wide, not tied to a dealership. Articles are read from the feed only —
 * the publishers' websites are never crawled.
 */
export const seoFeeds = pgTable(
  "seo_feeds",
  {
    id: serial("id").primaryKey(),
    label: varchar("label", { length: 200 }).notNull(),
    url: varchar("url", { length: 1000 }).notNull(),
    /** 1 = official search-engine source (Google, Bing) … 3 = industry publication. Official news ranks first in the newsletter. */
    priority: integer("priority").notNull().default(3),
    isEnabled: boolean("is_enabled").notNull().default(true),
    lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
    /** "ok", "error" or "rate_limited" (the publisher answered 429/503; the feed is paused until `nextFetchAfter`). */
    lastStatus: varchar("last_status", { length: 20 }),
    lastError: text("last_error"),
    /** Validators from the last full read, sent back so an unchanged feed answers 304 Not Modified. */
    etag: varchar("etag", { length: 500 }),
    lastModified: varchar("last_modified", { length: 100 }),
    /** Don't request the feed before this time (set when the publisher asks us to slow down). */
    nextFetchAfter: timestamp("next_fetch_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("seo_feeds_url_idx").on(sql`lower(${t.url})`)],
);

export const seoArticles = pgTable(
  "seo_articles",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    feedId: integer("feed_id")
      .notNull()
      .references(() => seoFeeds.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: varchar("url", { length: 2000 }).notNull(),
    urlHash: varchar("url_hash", { length: 64 }).notNull(),
    source: varchar("source", { length: 200 }).notNull(),
    summary: text("summary"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    /** Topic keys from news/seo-topics.ts, matched on headline and summary (deterministic, no AI). */
    topics: jsonb("topics").$type<string[]>().notNull().default([]),
    /** Ranking weight for "top stories": topic weights plus a bonus for official sources. */
    importance: integer("importance").notNull().default(0),
  },
  (t) => [uniqueIndex("seo_articles_url_idx").on(t.urlHash), index("seo_articles_published_idx").on(t.publishedAt), index("seo_articles_feed_idx").on(t.feedId)],
);

/* ────────────────────────────── Reports ────────────────────────────── */

export type ReportStatus = "queued" | "generating" | "completed" | "failed";
export const reports = pgTable(
  "reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dealershipId: integer("dealership_id")
      .notNull()
      .references(() => dealerships.id, { onDelete: "cascade" }),
    /** The scan the findings were built from. */
    scanId: bigint("scan_id", { mode: "number" }).references(() => seoScans.id, { onDelete: "set null" }),
    status: varchar("status", { length: 20 }).$type<ReportStatus>().notNull().default("queued"),
    /** sha256 of the findings + prompt version: identical inputs reuse the stored report instead of calling the AI again. */
    inputHash: varchar("input_hash", { length: 64 }),
    /** Deterministic findings (crawler/database facts only) the report is built from. */
    findings: jsonb("findings").$type<unknown>(),
    /** Narrative: executive summary and prioritised actions, validated against the findings. */
    narrative: jsonb("narrative").$type<unknown>(),
    /** "ai" when the narrative came from the model, "deterministic" when it was composed by code. */
    generator: varchar("generator", { length: 20 }),
    /** Why the deterministic generator was used instead (no API key, monthly limit reached, model declined…). */
    generatorNote: text("generator_note"),
    requestedBy: integer("requested_by"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("reports_dealership_idx").on(t.dealershipId, t.createdAt),
    index("reports_status_idx").on(t.status, t.updatedAt),
    index("reports_input_hash_idx").on(t.dealershipId, t.inputHash),
  ],
);

/** One row per model call, for the monthly report budget and cost tracking. */
export const reportRuns = pgTable(
  "report_runs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    reportId: bigint("report_id", { mode: "number" })
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    dealershipId: integer("dealership_id").notNull(),
    provider: varchar("provider", { length: 20 }).notNull(),
    model: varchar("model", { length: 60 }).notNull(),
    /** "succeeded", "refused", "invalid" (output failed validation) or "error". */
    status: varchar("status", { length: 20 }).notNull(),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("report_runs_created_idx").on(t.createdAt), index("report_runs_report_idx").on(t.reportId)],
);

/* ────────────────────────────── Notifications ──────────────────────── */

export const alerts = pgTable(
  "alerts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    dealershipId: integer("dealership_id")
      .notNull()
      .references(() => dealerships.id, { onDelete: "cascade" }),
    scanId: bigint("scan_id", { mode: "number" }),
    type: alertTypeEnum("type").notNull(),
    severity: severityEnum("severity").notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    message: text("message").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    includedInDigestAt: timestamp("included_in_digest_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("alerts_dedupe_idx").on(t.dedupeKey), index("alerts_dealership_idx").on(t.dealershipId, t.createdAt)],
);

export const emailReports = pgTable(
  "email_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    kind: emailKindEnum("kind").notNull(),
    dealershipId: integer("dealership_id").references(() => dealerships.id, { onDelete: "set null" }),
    recipients: jsonb("recipients").$type<string[]>().notNull(),
    subject: varchar("subject", { length: 500 }).notNull(),
    dedupeKey: varchar("dedupe_key", { length: 200 }).notNull(),
    status: emailStatusEnum("status").notNull().default("pending"),
    providerMessageId: varchar("provider_message_id", { length: 200 }),
    error: text("error"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("email_reports_dedupe_idx").on(t.dedupeKey), index("email_reports_dealership_idx").on(t.dealershipId, t.createdAt)],
);

/* ────────────────────────────── Jobs / scheduling ──────────────────── */

export const jobs = pgTable(
  "jobs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    type: jobTypeEnum("type").notNull(),
    dealershipId: integer("dealership_id").references(() => dealerships.id, { onDelete: "cascade" }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum("status").notNull().default("queued"),
    priority: integer("priority").notNull().default(100),
    runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: varchar("locked_by", { length: 100 }),
    lastError: text("last_error"),
    /** Crawler region that must run this job (SEO scans); null = default region. */
    region: varchar("region", { length: 40 }),
    /** Prevents duplicate active jobs (e.g. two scans of the same dealership). */
    dedupeKey: varchar("dedupe_key", { length: 200 }),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("jobs_pick_idx").on(t.status, t.runAfter, t.priority),
    uniqueIndex("jobs_dedupe_active_idx")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('queued', 'running')`),
  ],
);

export const settings = pgTable("settings", {
  key: varchar("key", { length: 80 }).primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const systemLogs = pgTable(
  "system_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    level: logLevelEnum("level").notNull(),
    source: varchar("source", { length: 80 }).notNull(),
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>(),
    dealershipId: integer("dealership_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("system_logs_created_idx").on(t.createdAt), index("system_logs_level_idx").on(t.level, t.createdAt)],
);

export const rateLimits = pgTable("rate_limits", {
  key: varchar("key", { length: 200 }).primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull().default(0),
});

/** Crawler workers report here so the dashboard can show which regions are online. */
export const crawlerWorkers = pgTable(
  "crawler_workers",
  {
    id: varchar("id", { length: 120 }).primaryKey(),
    region: varchar("region", { length: 40 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull().default("worker"),
    hostname: varchar("hostname", { length: 200 }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    currentJobId: bigint("current_job_id", { mode: "number" }),
    jobsProcessed: integer("jobs_processed").notNull().default(0),
  },
  (t) => [index("crawler_workers_region_idx").on(t.region, t.lastSeenAt)],
);

/** Short-lived per-host cache (robots.txt, sitemap URLs) to avoid re-downloading them on every scan. */
export const siteCache = pgTable(
  "site_cache",
  {
    host: varchar("host", { length: 255 }).notNull(),
    kind: varchar("kind", { length: 20 }).notNull(),
    data: jsonb("data").$type<unknown>().notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("site_cache_host_kind_idx").on(t.host, t.kind)],
);

/* ────────────────────────────── Types ──────────────────────────────── */

export type User = typeof users.$inferSelect;
export type PasswordReset = typeof passwordResets.$inferSelect;
export type Dealership = typeof dealerships.$inferSelect;
export type NewDealership = typeof dealerships.$inferInsert;
export type NewsKeyword = typeof newsKeywords.$inferSelect;
export type SeoScan = typeof seoScans.$inferSelect;
export type ScanPage = typeof scanPages.$inferSelect;
export type NewScanPage = typeof scanPages.$inferInsert;
export type ScanLink = typeof scanLinks.$inferSelect;
export type SeoCheck = typeof seoChecks.$inferSelect;
export type SeoIssue = typeof seoIssues.$inferSelect;
export type NewSeoIssue = typeof seoIssues.$inferInsert;
export type NewsArticle = typeof newsArticles.$inferSelect;
export type NewsSource = typeof newsSources.$inferSelect;
export type SeoFeed = typeof seoFeeds.$inferSelect;
export type SeoArticle = typeof seoArticles.$inferSelect;
export type Report = typeof reports.$inferSelect;
export type ReportRun = typeof reportRuns.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type EmailReport = typeof emailReports.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type SystemLog = typeof systemLogs.$inferSelect;
export type CrawlerWorker = typeof crawlerWorkers.$inferSelect;
export type ScanOutcome = (typeof scanOutcomeEnum.enumValues)[number];
