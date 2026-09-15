import "server-only";
import { z } from "zod";
import { applyEnvAliases } from "./env-aliases";

/**
 * Centralised, validated access to environment variables.
 * Secrets never leave the server: this module is marked `server-only`, so any
 * accidental import from a client component fails at build time.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  DATABASE_URL_UNPOOLED: z.string().optional(),
  APP_URL: z.string().url().default("http://localhost:3000"),
  AUTH_SECRET: z.string().min(16, "AUTH_SECRET must be at least 16 characters"),
  APP_TIMEZONE: z.string().default("America/Chicago"),
  CRON_SECRET: z.string().min(16, "CRON_SECRET must be at least 16 characters"),
  CRON_TICK_BUDGET_SECONDS: z.coerce.number().int().min(10).max(780).default(240),

  EMAIL_PROVIDER: z.enum(["resend", "smtp", "console"]).default("console"),
  EMAIL_FROM: z.string().default("A3 SEO Monitor <seo-monitor@example.com>"),
  RESEND_API_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  NEWSAPI_KEY: z.string().optional(),
  GNEWS_API_KEY: z.string().optional(),
  NEWS_PROVIDERS: z.string().default("google_rss,bing_rss"),

  /**
   * Honest bot identification (same convention as Googlebot). Defaults to
   * "Mozilla/5.0 (compatible; A3SEOMonitor/1.0; +<APP_URL>/bot)". robots.txt
   * rules for the "A3SEOMonitor" token are honoured.
   */
  CRAWLER_USER_AGENT: z.string().optional(),

  /**
   * Where SEO scans run. "vercel": Vercel Cron ticks crawl (functions pinned to
   * the US-East region in vercel.json). "worker": only dedicated crawler workers
   * crawl; Vercel handles the dashboard, news, emails and scheduling.
   */
  CRAWLER_MODE: z.enum(["vercel", "worker"]).default("vercel"),
  /** Region used when a dealership has no preferred region. */
  DEFAULT_CRAWLER_REGION: z.string().default("us-east"),
  /** Extra regions beyond US-East/Central/West, e.g. "eu-west:EU-West,ca-central:Canada". */
  CRAWLER_EXTRA_REGIONS: z.string().optional(),
  /** Region this worker process crawls for (standalone worker only). */
  WORKER_REGION: z.string().optional(),
  /** Job types this worker runs, comma-separated (default: all). e.g. "seo_scan" for a crawl-only regional worker. */
  WORKER_JOB_TYPES: z.string().optional(),
  /** When a site blocks the scanner, run a limited homepage check through Google PageSpeed Insights (needs PAGESPEED_API_KEY). */
  REMOTE_AUDIT_FALLBACK: z
    .string()
    .optional()
    .transform((v) => v !== "false" && v !== "0"),
  CRAWLER_DEFAULT_MAX_PAGES: z.coerce.number().int().min(5).max(500).default(40),
  CRAWLER_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  CRAWLER_DELAY_MS: z.coerce.number().int().min(0).max(10000).default(750),
  /** Upper bound on retries for transient failures (timeouts, dropped connections, 5xx). Refusals are never retried. */
  CRAWLER_MAX_RETRIES: z.coerce.number().int().min(0).max(3).default(1),

  /**
   * Bearer token for the machine-to-machine crawl-job API (POST /api/crawl-jobs).
   * The API is disabled when unset. Generate with: openssl rand -base64 32
   */
  CRAWLER_API_TOKEN: z.string().min(24, "CRAWLER_API_TOKEN must be at least 24 characters").optional(),

  /**
   * AI-assisted reports (Claude). Without a key, reports are still produced from
   * the same findings by the deterministic generator. The AI only summarises and
   * prioritises stored findings; it never computes or discovers SEO facts.
   */
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_REPORT_MODEL: z.string().default("claude-opus-5"),
  /** Model effort for report narratives. Summarising verified findings does not need the deepest reasoning. */
  AI_REPORT_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  /** Hard monthly ceiling on model calls for reports (UTC calendar month). Reused reports do not count. */
  AI_REPORTS_MONTHLY_LIMIT: z.coerce.number().int().min(0).max(100000).default(300),

  PAGESPEED_API_KEY: z.string().optional(),
  JOB_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),

  /**
   * Real-browser (Chromium/Playwright) rendering. The crawler keeps its honest
   * A3SEOMonitor identity and still honours robots.txt; a browser simply runs
   * the JavaScript that some sites require before serving HTML.
   *   "off"      HTTP fetch only (default; the only option that works on Vercel).
   *   "fallback" escalate to Chromium only when a page is refused or challenged.
   *   "always"   render every page with Chromium (slower; for JS-only sites).
   * Needs Chromium: the worker image ships one, locally run
   * `npx playwright install chromium` or point BROWSER_CHANNEL at an installed browser.
   */
  BROWSER_RENDERING: z.enum(["off", "fallback", "always"]).default("off"),
  /** Use an installed browser channel instead of Playwright's Chromium, e.g. "chrome". */
  BROWSER_CHANNEL: z.string().optional(),
  /** Explicit Chromium binary path (overrides BROWSER_CHANNEL). */
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().min(5000).max(120000).default(45000),
  /** How long a JavaScript challenge may take to resolve before we give up and report the refusal. */
  BROWSER_CHALLENGE_WAIT_MS: z.coerce.number().int().min(0).max(60000).default(12000),
  /** Longest wait for a rendered page to finish loading and stop changing before it is read (JavaScript-built content). */
  BROWSER_SETTLE_MS: z.coerce.number().int().min(0).max(30000).default(8000),
  /** Close the shared browser after this long with no page fetches (0 = keep open). */
  BROWSER_IDLE_TIMEOUT_MS: z.coerce.number().int().min(0).default(60000),
  /** Required when Chromium runs as root in a container. */
  BROWSER_NO_SANDBOX: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),
  /**
   * Pages Chromium may have open at once, across all scans in this process.
   * A browser page costs far more memory than an HTTP request, so this is
   * capped separately from JOB_CONCURRENCY: otherwise several parallel scans
   * each drive a browser and the worker exhausts memory before it runs out of work.
   */
  BROWSER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(8).default(2),
  /**
   * Per-host browser contexts (cookie jars) kept alive at once. Each site's
   * session is reused across its crawl; the least recently used idle context is
   * closed beyond this limit so a worker crawling many dealerships does not
   * accumulate one context per host.
   */
  BROWSER_MAX_CONTEXTS: z.coerce.number().int().min(1).max(50).default(4),

  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().default(5000),
  WORKER_ID: z.string().optional(),
});

export type Env = z.infer<typeof schema> & { CRAWLER_USER_AGENT: string };

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(applyEnvAliases(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = {
    ...parsed.data,
    CRAWLER_USER_AGENT: parsed.data.CRAWLER_USER_AGENT || `Mozilla/5.0 (compatible; A3SEOMonitor/1.0; +${parsed.data.APP_URL.replace(/\/$/, "")}/bot)`,
  };
  return cached;
}

export function isProduction() {
  return env().NODE_ENV === "production";
}
