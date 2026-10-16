/**
 * ─────────────────────────────────────────────────────────────────────────────
 *  SEO rule catalogue & scoring configuration
 * ─────────────────────────────────────────────────────────────────────────────
 *  Everything that influences the score lives in this file so it can be tuned
 *  without touching the engine. Scoring is fully deterministic (no AI):
 *
 *   • Each check belongs to a category and has `points` (its weight inside
 *     that category) and a `severity` used for reporting.
 *   • Page-scope checks deduct a fraction of their points based on the share
 *     of applicable pages affected, mapped through DEDUCTION_TIERS — one
 *     missing title out of 40 pages still costs something, a site-wide
 *     problem costs everything.
 *   • Site-scope checks are pass/fail: full points or nothing.
 *   • Checks with no applicable pages are "n/a" and excluded from the total.
 *   • Category score = 100 × (1 − deducted / applicable points in category).
 *   • Overall score = weighted mean of category scores (CATEGORIES weights).
 */

export type Category = "technical" | "metadata" | "content" | "links" | "images" | "structured_data" | "crawlability";
export type Severity = "critical" | "warning" | "info";
export type Scope = "page" | "site";

export interface CheckDef {
  key: string;
  category: Category;
  /** Name when passing (e.g. "Page title present"). */
  label: string;
  /** Name when failing, used for issues and reports (e.g. "Missing page titles"). */
  problem: string;
  description: string;
  severity: Severity;
  scope: Scope;
  points: number;
  recommendation: string;
}

export const CATEGORIES: Record<Category, { label: string; weight: number }> = {
  technical: { label: "Technical SEO", weight: 20 },
  metadata: { label: "Metadata", weight: 20 },
  content: { label: "Content structure", weight: 15 },
  links: { label: "Links", weight: 15 },
  images: { label: "Images", weight: 10 },
  structured_data: { label: "Structured data", weight: 10 },
  crawlability: { label: "Crawlability", weight: 10 },
};

/**
 * Fraction of a page-scope check's points deducted, by share of pages affected.
 * Evaluated top-down; the first tier whose `minRatio` is met applies.
 */
export const DEDUCTION_TIERS: Record<Severity, Array<{ minRatio: number; fraction: number }>> = {
  critical: [
    { minRatio: 0.5, fraction: 1 },
    { minRatio: 0.2, fraction: 0.8 },
    { minRatio: 0.05, fraction: 0.6 },
    { minRatio: 0, fraction: 0.4 },
  ],
  warning: [
    { minRatio: 0.6, fraction: 1 },
    { minRatio: 0.3, fraction: 0.75 },
    { minRatio: 0.1, fraction: 0.5 },
    { minRatio: 0, fraction: 0.25 },
  ],
  info: [
    { minRatio: 0.6, fraction: 1 },
    { minRatio: 0.3, fraction: 0.6 },
    { minRatio: 0, fraction: 0.3 },
  ],
};

/** Thresholds referenced by the checks and change detection. */
export const THRESHOLDS = {
  titleMin: 20,
  titleMax: 65,
  descriptionMin: 50,
  descriptionMax: 165,
  slowResponseMs: 3000,
  largeHtmlBytes: 1_500_000,
  blockingScriptsMax: 6,
  thinContentWords: 120,
  h2RequiredAboveWords: 350,
  lowInternalLinks: 3,
  /** Redirect hops at which reaching a crawled page counts as a redirect chain. */
  redirectChainHops: 2,
  /** Score change (points) that counts as "significant" for alerts/digests. */
  significantScoreDelta: 8,
  /** Max issue rows stored per check per scan (keeps storage bounded). */
  maxIssuesPerCheck: 200,
};

/**
 * External hosts whose bot protection returns misleading statuses (timeouts,
 * 403s or even 404s) to automated requests. Links to them are recorded as
 * "unverifiable" instead of "broken" to avoid false alarms. Includes social
 * networks, marketplaces and manufacturer (OEM) shopping/configurator sites.
 */
export const UNVERIFIABLE_LINK_HOSTS = [
  "facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "youtube.com", "youtu.be", "pinterest.com",
  "yelp.com", "google.com", "goo.gl", "apple.com", "carfax.com", "kbb.com", "edmunds.com", "cars.com", "autotrader.com", "cargurus.com", "dealerrater.com",
  "ford.com", "lincoln.com", "chevrolet.com", "gmc.com", "buick.com", "cadillac.com", "toyota.com", "lexus.com", "honda.com", "acura.com",
  "bmwusa.com", "mbusa.com", "audiusa.com", "vw.com", "nissanusa.com", "infinitiusa.com", "hyundaiusa.com", "kia.com", "subaru.com", "mazdausa.com",
  "jeep.com", "ramtrucks.com", "dodge.com", "chrysler.com", "porsche.com", "volvocars.com", "landroverusa.com", "jaguarusa.com", "genesis.com",
];

export function isUnverifiableHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  return UNVERIFIABLE_LINK_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}

/** Page types where thin content is a real problem (not listings/VDPs/contact). */
export const THIN_CONTENT_PAGE_TYPES = ["home", "service", "parts", "finance", "about", "specials"];

export const DEALER_SCHEMA_TYPES = ["AutoDealer", "AutomotiveBusiness", "LocalBusiness", "Organization", "Store", "CarDealer", "AutoRepair"];

/** Structured-data types that describe a single vehicle for sale on a vehicle detail page (VDP). */
export const VEHICLE_SCHEMA_TYPES = ["Vehicle", "Car", "Motorcycle", "MotorizedBicycle", "BusOrCoach", "Product", "IndividualProduct"];

/** schema.org availability values that mean the vehicle can no longer be bought. */
export const SOLD_AVAILABILITY = ["SoldOut", "Discontinued"];

export const CHECKS: CheckDef[] = [
  /* ── Technical ─────────────────────────────────────────────────────── */
  {
    key: "site_unavailable",
    category: "technical",
    label: "Website reachable",
    problem: "Website unavailable",
    description: "The homepage responds successfully.",
    severity: "critical",
    scope: "site",
    points: 15,
    recommendation: "Confirm the website is online and the homepage returns HTTP 200. Contact the website provider immediately if it is down.",
  },
  {
    key: "http_error",
    category: "technical",
    label: "Pages load without errors",
    problem: "Pages failing to load",
    description: "Crawled pages return HTTP 200 and are reachable.",
    severity: "critical",
    scope: "page",
    points: 10,
    recommendation: "Fix or redirect the page so it returns HTTP 200, or remove links pointing to it.",
  },
  {
    key: "not_https",
    category: "technical",
    label: "Served over HTTPS",
    problem: "Pages not served over HTTPS",
    description: "Pages are delivered over a secure connection.",
    severity: "critical",
    scope: "page",
    points: 8,
    recommendation: "Serve every page over HTTPS and redirect HTTP requests to the HTTPS version.",
  },
  {
    key: "mixed_content",
    category: "technical",
    label: "No mixed content",
    problem: "Insecure (mixed) content",
    description: "HTTPS pages do not load images, scripts or styles over HTTP.",
    severity: "warning",
    scope: "page",
    points: 4,
    recommendation: "Update insecure http:// resource URLs to https:// so browsers do not block or warn about them.",
  },
  {
    key: "viewport_missing",
    category: "technical",
    label: "Mobile viewport set",
    problem: "Missing mobile viewport",
    description: "A viewport meta tag is present for mobile rendering.",
    severity: "warning",
    scope: "page",
    points: 4,
    recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the page head.',
  },
  {
    key: "lang_missing",
    category: "technical",
    label: "Language declared",
    problem: "Missing language attribute",
    description: "The <html> element declares a lang attribute.",
    severity: "info",
    scope: "page",
    points: 2,
    recommendation: 'Add lang="en" (or the appropriate language) to the <html> element.',
  },
  {
    key: "slow_response",
    category: "technical",
    label: "Server response time",
    problem: "Slow server response",
    description: `Pages respond within ${THRESHOLDS.slowResponseMs / 1000} seconds.`,
    severity: "warning",
    scope: "page",
    points: 5,
    recommendation: "Investigate server/hosting performance and caching; slow responses hurt rankings and Core Web Vitals.",
  },
  {
    key: "large_html",
    category: "technical",
    label: "Reasonable HTML size",
    problem: "Oversized HTML pages",
    description: "HTML documents are under 1.5 MB.",
    severity: "warning",
    scope: "page",
    points: 3,
    recommendation: "Reduce inline scripts/styles and embedded data so the HTML document is smaller and faster to parse.",
  },
  {
    key: "client_redirect",
    category: "technical",
    label: "No client-side redirects",
    problem: "Client-side (JavaScript/meta) redirects",
    description: "Pages do not rely on meta-refresh or JavaScript redirects.",
    severity: "warning",
    scope: "page",
    points: 5,
    recommendation: "Replace the meta-refresh/JavaScript redirect with a server-side 301 redirect. If the homepage redirects to a parking or landing page, confirm the domain is still pointed at the dealership website.",
  },
  {
    key: "blocking_scripts",
    category: "technical",
    label: "Render-blocking scripts",
    problem: "Too many render-blocking scripts",
    description: `No more than ${THRESHOLDS.blockingScriptsMax} synchronous scripts in the document head.`,
    severity: "info",
    scope: "page",
    points: 3,
    recommendation: "Add defer/async to non-critical scripts or move them to the end of the body to improve loading performance.",
  },
  {
    key: "redirect_chain",
    category: "technical",
    label: "No redirect chains",
    problem: "Pages reached through redirect chains",
    description: `Pages are reached in at most one redirect, not a chain of ${THRESHOLDS.redirectChainHops} or more.`,
    severity: "warning",
    scope: "page",
    points: 3,
    recommendation: "Point the old URL straight at the final page with a single 301 redirect, and update links and sitemap entries to the final URL. Each extra hop slows visitors down and wastes search-engine crawl budget.",
  },

  /* ── Metadata ──────────────────────────────────────────────────────── */
  {
    key: "title_missing",
    category: "metadata",
    label: "Page title present",
    problem: "Missing page titles",
    description: "Every page has a <title>.",
    severity: "critical",
    scope: "page",
    points: 8,
    recommendation: 'Add a unique, descriptive title (e.g. "New BMW X5 for Sale in Fort Walton Beach | BMW of Fort Walton Beach").',
  },
  {
    key: "title_length",
    category: "metadata",
    label: "Title length",
    problem: "Titles too short or too long",
    description: `Titles are between ${THRESHOLDS.titleMin} and ${THRESHOLDS.titleMax} characters.`,
    severity: "warning",
    scope: "page",
    points: 4,
    recommendation: `Rewrite the title to ${THRESHOLDS.titleMin}–${THRESHOLDS.titleMax} characters with the primary keyword and dealership name.`,
  },
  {
    key: "title_duplicate",
    category: "metadata",
    label: "Unique titles",
    problem: "Duplicate titles",
    description: "No two pages share the same title.",
    severity: "warning",
    scope: "page",
    points: 5,
    recommendation: "Give each page a unique title that describes its specific content.",
  },
  {
    key: "description_missing",
    category: "metadata",
    label: "Meta description present",
    problem: "Missing meta descriptions",
    description: "Every page has a meta description.",
    severity: "warning",
    scope: "page",
    points: 6,
    recommendation: "Add a compelling meta description (50–165 characters) summarising the page and including a call to action.",
  },
  {
    key: "description_length",
    category: "metadata",
    label: "Meta description length",
    problem: "Meta descriptions too short or too long",
    description: `Descriptions are between ${THRESHOLDS.descriptionMin} and ${THRESHOLDS.descriptionMax} characters.`,
    severity: "info",
    scope: "page",
    points: 3,
    recommendation: `Adjust the meta description to ${THRESHOLDS.descriptionMin}–${THRESHOLDS.descriptionMax} characters so it displays fully in search results.`,
  },
  {
    key: "description_duplicate",
    category: "metadata",
    label: "Unique meta descriptions",
    problem: "Duplicate meta descriptions",
    description: "No two pages share the same meta description.",
    severity: "warning",
    scope: "page",
    points: 4,
    recommendation: "Write a distinct meta description for each page.",
  },
  {
    key: "canonical_missing",
    category: "metadata",
    label: "Canonical tag present",
    problem: "Missing canonical tags",
    description: "Pages declare a canonical URL.",
    severity: "warning",
    scope: "page",
    points: 4,
    recommendation: 'Add <link rel="canonical" href="…"> pointing to the preferred URL of each page.',
  },
  {
    key: "canonical_mismatch",
    category: "metadata",
    label: "Canonical points to itself",
    problem: "Canonical points to another page",
    description: "The canonical URL matches the page URL.",
    severity: "warning",
    scope: "page",
    points: 4,
    recommendation: "Verify the canonical URL is intentional. A canonical pointing to another page tells search engines not to index this one.",
  },
  {
    key: "og_missing",
    category: "metadata",
    label: "Open Graph tags",
    problem: "Missing Open Graph tags",
    description: "og:title, og:description and og:image are present for social sharing.",
    severity: "info",
    scope: "page",
    points: 3,
    recommendation: "Add Open Graph meta tags (og:title, og:description, og:image, og:url) so shared links render correctly on social platforms.",
  },
  {
    key: "hreflang_invalid",
    category: "metadata",
    label: "hreflang annotations valid",
    problem: "Invalid hreflang annotations",
    description: "Pages that declare language alternates (hreflang) use valid language/region codes, list themselves, include x-default and are confirmed by return links.",
    severity: "warning",
    scope: "page",
    points: 3,
    recommendation: 'Fix the hreflang tags: use ISO codes such as "en-US" or "es-US" (not "en_US" or "en-UK"), include a tag pointing to the page itself, add an "x-default" alternate, and make every alternate page link back. Search engines ignore hreflang sets with these errors.',
  },

  /* ── Content ───────────────────────────────────────────────────────── */
  {
    key: "h1_missing",
    category: "content",
    label: "H1 heading present",
    problem: "Missing H1 headings",
    description: "Each page has an H1 heading.",
    severity: "warning",
    scope: "page",
    points: 6,
    recommendation: "Add a single, descriptive H1 heading that reflects the page topic.",
  },
  {
    key: "h1_multiple",
    category: "content",
    label: "Single H1",
    problem: "Multiple H1 headings",
    description: "Pages do not have multiple H1 headings.",
    severity: "info",
    scope: "page",
    points: 3,
    recommendation: "Keep one H1 per page; demote additional H1s to H2/H3.",
  },
  {
    key: "h2_missing",
    category: "content",
    label: "H2 structure",
    problem: "No H2 subheadings on long pages",
    description: `Pages with more than ${THRESHOLDS.h2RequiredAboveWords} words use H2 subheadings.`,
    severity: "info",
    scope: "page",
    points: 2,
    recommendation: "Break long content into sections with H2 headings to improve readability and topical clarity.",
  },
  {
    key: "thin_content",
    category: "content",
    label: "Sufficient content",
    problem: "Thin content on key pages",
    description: `Key pages have more than ${THRESHOLDS.thinContentWords} words of text.`,
    severity: "warning",
    scope: "page",
    points: 4,
    recommendation: "Add helpful, unique content (department details, FAQs, local information) so the page provides value beyond navigation.",
  },
  {
    key: "vdp_price_missing",
    category: "content",
    label: "Vehicle pages show a price",
    problem: "Vehicle pages without a price",
    description: 'Vehicle detail pages show a price, publish one in their structured data (offers.price), or state how to get one ("Call for price").',
    severity: "warning",
    scope: "page",
    points: 2,
    recommendation: 'Show the vehicle\'s price on the page and in its Vehicle/Offer structured data. If the price cannot be advertised, say so explicitly ("Call for price", "Unlock our best price") so shoppers and Google vehicle listings are not left guessing.',
  },

  /* ── Links ─────────────────────────────────────────────────────────── */
  {
    key: "broken_internal_link",
    category: "links",
    label: "No broken internal links",
    problem: "Broken internal links",
    description: "Internal links resolve without errors.",
    severity: "warning",
    scope: "page",
    points: 8,
    recommendation: "Update or remove the broken link, or restore/redirect the target page.",
  },
  {
    key: "broken_external_link",
    category: "links",
    label: "No broken external links",
    problem: "Broken external links",
    description: "External links resolve without errors.",
    severity: "info",
    scope: "page",
    points: 3,
    recommendation: "Update the link to a working URL or remove it.",
  },
  {
    key: "internal_link_redirects",
    category: "links",
    label: "Internal links point to final URLs",
    problem: "Internal links to redirecting URLs",
    description: "Internal links point directly at the final URL rather than at an old or insecure (http://) address that redirects.",
    severity: "info",
    scope: "page",
    points: 2,
    recommendation: "Update the link to the final URL shown, so visitors and search engines reach the page without a redirect. Links to moved pages usually come from old menus, footers or blog posts.",
  },
  {
    key: "low_internal_links",
    category: "links",
    label: "Internal linking",
    problem: "Few internal links",
    description: `Pages link to at least ${THRESHOLDS.lowInternalLinks} other internal pages.`,
    severity: "info",
    scope: "page",
    points: 2,
    recommendation: "Add contextual internal links to related pages (inventory, service, specials) to help crawlers and visitors.",
  },

  /* ── Images ────────────────────────────────────────────────────────── */
  {
    key: "image_alt_missing",
    category: "images",
    label: "Image alt text",
    problem: "Missing image alt text",
    description: "Images have alt attributes.",
    severity: "warning",
    scope: "page",
    points: 8,
    recommendation: 'Add descriptive alt text to images (e.g. "2026 BMW X3 in Alpine White"). Use alt="" for purely decorative images.',
  },
  {
    key: "image_dimensions_missing",
    category: "images",
    label: "Image dimensions",
    problem: "Images without width/height",
    description: "Images declare width and height to avoid layout shift.",
    severity: "info",
    scope: "page",
    points: 2,
    recommendation: "Add width and height attributes to <img> tags to reduce Cumulative Layout Shift.",
  },

  /* ── Structured data ───────────────────────────────────────────────── */
  {
    key: "schema_missing",
    category: "structured_data",
    label: "Structured data present",
    problem: "Missing structured data",
    description: "Pages include JSON-LD or microdata.",
    severity: "warning",
    scope: "page",
    points: 5,
    recommendation: "Add JSON-LD structured data (Vehicle, Offer, FAQPage, BreadcrumbList as appropriate) to help search engines understand the page.",
  },
  {
    key: "schema_invalid",
    category: "structured_data",
    label: "Structured data parses",
    problem: "Invalid structured data",
    description: "JSON-LD blocks are valid JSON.",
    severity: "warning",
    scope: "page",
    points: 3,
    recommendation: "Fix the JSON syntax error in the ld+json script block (validate with the Schema Markup Validator).",
  },
  {
    key: "dealer_schema_missing",
    category: "structured_data",
    label: "Dealership schema on homepage",
    problem: "No dealership schema on homepage",
    description: "The homepage declares AutoDealer / LocalBusiness / Organization schema.",
    severity: "warning",
    scope: "site",
    points: 4,
    recommendation: "Add AutoDealer (or AutomotiveBusiness/LocalBusiness) JSON-LD on the homepage with name, address, phone, opening hours and sameAs links.",
  },
  {
    key: "vdp_schema_missing",
    category: "structured_data",
    label: "Vehicle schema on vehicle pages",
    problem: "Vehicle pages without vehicle schema",
    description: "Vehicle detail pages declare Vehicle, Car or Product structured data.",
    severity: "warning",
    scope: "page",
    points: 4,
    recommendation: "Add Vehicle (or Car) JSON-LD to every vehicle detail page with VIN, make, model, year, mileage, condition, image and an Offer (price, priceCurrency, availability). This is what Google uses for vehicle listings and rich results.",
  },
  {
    key: "nap_inconsistent",
    category: "structured_data",
    label: "Consistent dealership name, address and phone",
    problem: "Inconsistent dealership address or phone",
    description: "The dealership's structured data gives the same address and main phone number on every page.",
    severity: "warning",
    scope: "site",
    points: 3,
    recommendation: "Use one address and one main phone number for the dealership in the structured data on every page, matching the Google Business Profile. Department numbers (service, parts) belong in their own department entries.",
  },

  /* ── Crawlability ──────────────────────────────────────────────────── */
  {
    key: "robots_missing",
    category: "crawlability",
    label: "robots.txt present",
    problem: "Missing robots.txt",
    description: "A robots.txt file is available.",
    severity: "warning",
    scope: "site",
    points: 3,
    recommendation: "Publish a robots.txt at the site root that allows crawling and references the XML sitemap.",
  },
  {
    key: "robots_blocks_all",
    category: "crawlability",
    label: "robots.txt allows search engines",
    problem: "robots.txt blocks search engines",
    description: "robots.txt does not block Googlebot or all crawlers from the homepage.",
    severity: "critical",
    scope: "site",
    points: 6,
    recommendation: "Remove the Disallow rule blocking search engines. This usually indicates a staging configuration left in production.",
  },
  {
    key: "sitemap_missing",
    category: "crawlability",
    label: "XML sitemap present",
    problem: "Missing XML sitemap",
    description: "An XML sitemap is available.",
    severity: "warning",
    scope: "site",
    points: 4,
    recommendation: "Publish an XML sitemap (e.g. /sitemap.xml) and reference it in robots.txt and Google Search Console.",
  },
  {
    key: "sitemap_not_in_robots",
    category: "crawlability",
    label: "Sitemap referenced in robots.txt",
    problem: "Sitemap not referenced in robots.txt",
    description: "robots.txt contains a Sitemap: directive.",
    severity: "info",
    scope: "site",
    points: 1,
    recommendation: "Add a 'Sitemap: https://…/sitemap.xml' line to robots.txt so all search engines can discover it.",
  },
  {
    key: "sitemap_empty",
    category: "crawlability",
    label: "XML sitemap has URLs",
    problem: "Empty XML sitemap",
    description: "The sitemap lists at least one URL from this site.",
    severity: "warning",
    scope: "site",
    points: 2,
    recommendation: "Regenerate the sitemap so it lists the site's indexable pages.",
  },
  {
    key: "noindex_important",
    category: "crawlability",
    label: "Key pages indexable",
    problem: "Key pages marked noindex",
    description: "Homepage and key dealership pages are not marked noindex.",
    severity: "critical",
    scope: "page",
    points: 6,
    recommendation: "Remove the noindex directive (meta robots or X-Robots-Tag) from this page so it can appear in search results.",
  },
  {
    key: "noindex_page",
    category: "crawlability",
    label: "Pages indexable",
    problem: "Pages marked noindex",
    description: "Other crawled pages are indexable.",
    severity: "info",
    scope: "page",
    points: 1,
    recommendation: "Confirm the noindex directive is intentional for this page.",
  },
  {
    key: "vdp_sold_indexed",
    category: "crawlability",
    label: "Sold vehicles not indexable",
    problem: "Sold vehicles still indexable",
    description: "Vehicle pages that say the vehicle is sold or no longer available are removed, redirected or marked noindex.",
    severity: "warning",
    scope: "page",
    points: 3,
    recommendation: "When a vehicle is sold, return 410/404, 301-redirect the page to the matching model or inventory page, or mark it noindex, and remove it from the sitemap. Sold vehicles left in search results frustrate shoppers.",
  },
  {
    key: "important_page_missing",
    category: "crawlability",
    label: "Key dealership pages linked",
    problem: "Key dealership pages missing",
    description: "New & used inventory, service, parts, finance, specials, about and contact pages are linked from the site.",
    severity: "warning",
    scope: "site",
    points: 4,
    recommendation: "Make sure this page exists and is linked from the main navigation so visitors and search engines can find it.",
  },
];

export const CHECKS_BY_KEY: Record<string, CheckDef> = Object.fromEntries(CHECKS.map((c) => [c.key, c]));

export function checkDef(key: string): CheckDef {
  const def = CHECKS_BY_KEY[key];
  if (!def) throw new Error(`Unknown SEO check: ${key}`);
  return def;
}
