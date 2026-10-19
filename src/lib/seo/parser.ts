import * as cheerio from "cheerio";
import type { NapEntity, NapFacts, VehiclePageFacts } from "@/lib/db/schema";
import { cleanText } from "@/lib/security/sanitize";
import { DEALER_SCHEMA_TYPES, VEHICLE_SCHEMA_TYPES } from "./checks/config";
import { resolveHref, isSameSite, normalizeUrl } from "./url";

/** Hosts that serve conversion/analytics beacons rather than images a visitor sees. */
const TRACKING_PIXEL_HOSTS =
  /(^|\.)(facebook\.com|facebook\.net|arttrk\.com|xad\.com|crwdcntrl\.net|doubleclick\.net|google-analytics\.com|googleadservices\.com|googlesyndication\.com|bat\.bing\.com|analytics\.twitter\.com|ads-twitter\.com|t\.co|px\.ads\.linkedin\.com|ct\.pinterest\.com|adsrvr\.org|quantserve\.com|scorecardresearch\.com|demdex\.net|everesttech\.net|adnxs\.com|taboola\.com|outbrain\.com|tiktok\.com|snapchat\.com|clarity\.ms)$/i;

/**
 * True for an <img> that exists only to fire a tracking request: a known beacon
 * host, a 0–1px image, or one that is never displayed. Such images have no
 * meaning to a reader, so alt text and dimensions do not apply to them.
 */
export function isTrackingPixel(img: { src: string; width?: string; height?: string; style?: string; hidden?: boolean }): boolean {
  if (img.hidden) return true;
  if (img.style && /(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(img.style)) return true;
  const w = img.width === undefined ? NaN : Number.parseFloat(img.width);
  const h = img.height === undefined ? NaN : Number.parseFloat(img.height);
  if (w <= 1 && h <= 1) return true;
  try {
    return TRACKING_PIXEL_HOSTS.test(new URL(img.src, "https://placeholder.invalid/").hostname);
  } catch {
    return false;
  }
}

export interface ExtractedLink {
  url: string;
  normalized: string;
  isInternal: boolean;
  anchor: string;
  nofollow: boolean;
}

export interface PageData {
  title: string | null;
  metaDescription: string | null;
  h1: string[];
  h2: string[];
  canonical: string | null;
  robotsMeta: string | null;
  lang: string | null;
  hasViewport: boolean;
  wordCount: number;
  links: ExtractedLink[];
  internalLinksCount: number;
  externalLinksCount: number;
  imagesCount: number;
  imagesMissingAlt: number;
  imagesMissingAltSamples: string[];
  imagesWithoutDimensions: number;
  scriptsCount: number;
  blockingScriptsCount: number;
  stylesheetsCount: number;
  mixedContentCount: number;
  schemaTypes: string[];
  schemaErrors: number;
  openGraph: Record<string, string>;
  twitterCard: boolean;
  /** Target of a meta-refresh or script-only redirect (search engines handle these poorly). */
  clientRedirect: { type: "meta" | "script"; target: string } | null;
  /** <link rel="alternate" hreflang> annotations, hrefs resolved to absolute URLs. */
  hreflang: Array<{ lang: string; href: string }>;
  /** Vehicle identity, price and availability signals (only meaningful on vehicle detail pages). */
  vehicle: VehiclePageFacts;
  /** Dealership name/address/phone from structured data plus visible numbers; null when the page has none. */
  nap: NapFacts | null;
}

const MAX_HREFLANG = 60;
const MAX_NAP_ENTITIES = 5;
const MAX_VISIBLE_PHONES = 6;

/** A dollar amount: "$32,995", "$ 32995.00". Amounts under $1,000 (fees, "$500 off") are not a vehicle price. */
const PRICE_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d{2})?(?!\d)/g;
/** Price fields in inline JavaScript state, for platforms that render the price client-side. */
const SCRIPT_PRICE_RE = /["']?(?:price|internetPrice|sellingPrice|salePrice|finalPrice|askingPrice|displayedPrice|msrp)["']?\s*[:=]\s*["']?\$?\s?(\d{1,3}(?:,\d{3})+|\d{4,7})(?:\.\d{1,2})?/gi;
/**
 * An explicit statement that the price is available on request. New vehicles
 * are often advertised this way because manufacturer pricing rules (MAP) forbid
 * publishing the dealer's price, so it is a deliberate choice, not a defect.
 */
const PRICE_STATEMENT_RE =
  /\b(?:(?:call|contact(?: us)?|ask|email|text)\b[^.!?]{0,30}?\b(?:for|about)\s+(?:our\s+|the\s+)?(?:best\s+|lowest\s+|today'?s\s+|current\s+)?(?:price|pricing)|price\s+(?:on|upon)\s+request|(?:get|unlock|reveal)\s+(?:your\s+|our\s+|the\s+)?(?:e-?price|best\s+price|today'?s\s+price|instant\s+price|price)|see\s+price\s+in\s+cart)\b/i;
/** Clear sentences that the vehicle itself is sold. A "SOLD" badge on a similar-vehicles carousel does not match. */
const SOLD_RE =
  /\b(?:this\s+(?:vehicle|car|truck|suv|unit)\s+(?:has\s+(?:already\s+)?been\s+sold|(?:is\s+)?(?:no\s+longer\s+available|no\s+longer\s+in\s+(?:our\s+)?(?:stock|inventory)|sold))|(?:vehicle|car)\s+(?:is\s+)?no\s+longer\s+available|sorry,?\s+(?:this|the)\s+(?:vehicle|car)\s+(?:has\s+been\s+sold|is\s+sold|is\s+no\s+longer\s+available))\b/i;
const VIN_CHARS = /^[A-HJ-NPR-Z0-9]{17}$/i;
const LABELLED_VIN_RE = /\bVIN\b\s*(?:#|number|no\.?)?\s*:?\s*([A-HJ-NPR-Z0-9]{17})\b/i;
const US_PHONE_RE = /\(?\b([2-9]\d{2})\)?[-.\s]?([2-9]\d{2})[-.\s]?(\d{4})\b/g;

/** A plausible VIN: the right characters, with both letters and digits (rules out long numeric ids and words). */
function looksLikeVin(s: string): boolean {
  return VIN_CHARS.test(s) && /\d/.test(s) && /[a-z]/i.test(s);
}

function parseAmount(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const n = Number.parseFloat(raw.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "https://schema.org/SoldOut" → "SoldOut". */
function lastSegment(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return v.trim().split("/").pop()!.slice(0, 40) || null;
}

/** Phone number as comparable digits: 10 for US numbers (a leading 1 dropped), extension removed. */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const main = raw.split(/\s*(?:ext\.?|extension|x)\s*\d/i)[0];
  let digits = main.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

function typesOf(node: Record<string, unknown>): string[] {
  const t = node["@type"];
  return typeof t === "string" ? [t] : Array.isArray(t) ? t.filter((x): x is string => typeof x === "string") : [];
}

function str(v: unknown, max = 200): string | null {
  if (Array.isArray(v)) return str(v[0], max);
  return typeof v === "string" ? cleanText(v, max) || null : null;
}

/** Display form and comparison key of a schema.org address (object or plain string). */
export function napAddress(raw: unknown): { address: string | null; addressKey: string | null } {
  const a = Array.isArray(raw) ? raw[0] : raw;
  let street: string | null = null;
  let city: string | null = null;
  let region: string | null = null;
  let zip: string | null = null;
  if (typeof a === "string") {
    street = cleanText(a, 300) || null;
    zip = /\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/.exec(a)?.[1] ?? null;
  } else if (a && typeof a === "object") {
    const o = a as Record<string, unknown>;
    street = str(o.streetAddress);
    city = str(o.addressLocality, 100);
    region = str(o.addressRegion, 60);
    zip = /\d{5}/.exec(String(o.postalCode ?? ""))?.[0] ?? null;
  }
  if (!street && !zip) return { address: null, addressKey: null };
  const address = [street, city, [region, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ") || null;
  const number = street ? /^\s*(\d+[a-z]?)\b/i.exec(street)?.[1]?.toLowerCase() : undefined;
  const addressKey = number && zip ? `${number}|${zip}` : street ? `${street.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}|${(city ?? "").toLowerCase()}` : null;
  return { address, addressKey };
}

/**
 * Dealership entities declared at the top level of a JSON-LD block (or in its
 * @graph, or as a WebPage's mainEntity). Departments and sub-organisations are
 * left out on purpose: their own service/parts numbers are legitimate.
 */
function collectNapEntities(roots: unknown[]): NapEntity[] {
  const out: NapEntity[] = [];
  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 3 || out.length >= MAX_NAP_ENTITIES) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (obj["@graph"]) visit(obj["@graph"], depth + 1);
    if (obj.mainEntity) visit(obj.mainEntity, depth + 1);
    if (!typesOf(obj).some((t) => DEALER_SCHEMA_TYPES.includes(t))) return;
    const phone = normalizePhone(Array.isArray(obj.telephone) ? obj.telephone[0] : obj.telephone);
    const { address, addressKey } = napAddress(obj.address);
    if (!phone && !addressKey) return;
    out.push({ name: str(obj.name), phone, address, addressKey });
  };
  for (const r of roots) visit(r, 0);
  return out;
}

/** Vehicle/Car/Product nodes anywhere in the JSON-LD (bounded depth). */
function collectVehicleNodes(node: unknown, out: Array<Record<string, unknown>>, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6 || out.length >= 10) return;
  if (Array.isArray(node)) {
    for (const n of node) collectVehicleNodes(n, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  if (typesOf(obj).some((t) => VEHICLE_SCHEMA_TYPES.includes(t))) out.push(obj);
  for (const [k, v] of Object.entries(obj)) if (k !== "offers" && v && typeof v === "object") collectVehicleNodes(v, out, depth + 1);
}

/** Price and availability from a node's offers (Offer, AggregateOffer, arrays, priceSpecification). */
function offerFacts(node: Record<string, unknown>): { price: number | null; availability: string | null } {
  const offers = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
  let price: number | null = null;
  let availability: string | null = null;
  for (const o of offers) {
    if (!o || typeof o !== "object") continue;
    const offer = o as Record<string, unknown>;
    const specs = Array.isArray(offer.priceSpecification) ? offer.priceSpecification : offer.priceSpecification ? [offer.priceSpecification] : [];
    price ??= parseAmount(offer.price) ?? parseAmount(offer.lowPrice) ?? specs.map((s) => parseAmount((s as Record<string, unknown> | null)?.price)).find((p) => p !== null) ?? null;
    availability ??= lastSegment(offer.availability);
  }
  return { price, availability };
}

const MAX_LINKS_PER_PAGE = 400;
const MAX_EXTERNAL_LINKS_PER_PAGE = 60;

function collectSchemaTypes(node: unknown, out: Set<string>, depth = 0) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const n of node) collectSchemaTypes(n, out, depth + 1);
    return;
  }
  if (typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") out.add(t);
    else if (Array.isArray(t)) for (const x of t) if (typeof x === "string") out.add(x);
    if (obj["@graph"]) collectSchemaTypes(obj["@graph"], out, depth + 1);
    for (const k of ["mainEntity", "itemListElement", "hasOfferCatalog", "department", "subOrganization"]) {
      if (obj[k]) collectSchemaTypes(obj[k], out, depth + 1);
    }
  }
}

/** Extract everything the checks need from an HTML document. Pure function. */
export function parsePage(html: string, pageUrl: string): PageData {
  const $ = cheerio.load(html);
  const base = $("base[href]").attr("href");
  const resolvedBase = base ? (resolveHref(base, pageUrl)?.toString() ?? pageUrl) : pageUrl;
  const page = new URL(pageUrl);

  const metaByName = (name: string) => {
    let val: string | undefined;
    $("meta[name]").each((_, el) => {
      if (val === undefined && ($(el).attr("name") ?? "").trim().toLowerCase() === name) val = $(el).attr("content");
    });
    return val;
  };

  const title = cleanText($("head > title").first().text() || $("title").first().text(), 500) || null;
  const metaDescription = cleanText(metaByName("description"), 1000) || null;
  const h1 = $("h1")
    .map((_, el) => cleanText($(el).text(), 300))
    .get()
    .filter(Boolean)
    .slice(0, 20);
  const h2 = $("h2")
    .map((_, el) => cleanText($(el).text(), 300))
    .get()
    .filter(Boolean)
    .slice(0, 40);

  let canonical: string | null = null;
  $("link[rel]").each((_, el) => {
    if (canonical === null && ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical")) {
      const href = $(el).attr("href");
      const r = href ? resolveHref(href, resolvedBase) : null;
      canonical = r ? r.toString() : href?.trim() || null;
    }
  });

  const robotsParts = [metaByName("robots"), metaByName("googlebot")].filter(Boolean) as string[];
  const robotsMeta = robotsParts.length ? cleanText(robotsParts.join(", "), 200) : null;
  const lang = cleanText($("html").attr("lang"), 20) || null;
  const hasViewport = Boolean(metaByName("viewport"));

  // Word count of visible text (scripts, styles, templates and nav chrome removed).
  const $body = $("body").clone();
  $body.find("script, style, noscript, template, svg, iframe").remove();
  const text = cleanText($body.text(), 400_000);
  const wordCount = text ? text.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w)).length : 0;

  // Links
  const seen = new Map<string, ExtractedLink>();
  let external = 0;
  $("a[href]").each((_, el) => {
    if (seen.size >= MAX_LINKS_PER_PAGE) return false;
    const href = $(el).attr("href") ?? "";
    const resolved = resolveHref(href, resolvedBase);
    if (!resolved) return;
    let normalized: string;
    try {
      normalized = normalizeUrl(resolved);
    } catch {
      return;
    }
    if (seen.has(normalized)) return;
    const isInternal = isSameSite(page, resolved);
    if (!isInternal) {
      if (external >= MAX_EXTERNAL_LINKS_PER_PAGE) return;
      external++;
    }
    const rel = ($(el).attr("rel") ?? "").toLowerCase();
    seen.set(normalized, {
      url: resolved.toString(),
      normalized,
      isInternal,
      anchor: cleanText($(el).text() || $(el).attr("aria-label") || $(el).attr("title") || $(el).find("img").attr("alt"), 200),
      nofollow: rel.split(/\s+/).includes("nofollow"),
    });
  });
  const links = [...seen.values()];

  // Images
  let imagesCount = 0;
  let imagesMissingAlt = 0;
  let imagesWithoutDimensions = 0;
  const imagesMissingAltSamples: string[] = [];
  $("img").each((_, el) => {
    const $img = $(el);
    if ($img.attr("role") === "presentation" || $img.attr("aria-hidden") === "true") return;
    const src = $img.attr("src") ?? $img.attr("data-src") ?? "";
    if (/^data:/i.test(src)) return;
    // Ad/analytics beacons are injected as <img> but are not content: counting them
    // flagged "missing alt text" on every page of sites whose real images were fine.
    if (isTrackingPixel({ src, width: $img.attr("width"), height: $img.attr("height"), style: $img.attr("style"), hidden: $img.attr("hidden") !== undefined })) return;
    imagesCount++;
    if ($img.attr("alt") === undefined) {
      imagesMissingAlt++;
      if (imagesMissingAltSamples.length < 5) imagesMissingAltSamples.push(cleanText(src, 300) || "(inline image)");
    }
    if (!$img.attr("width") || !$img.attr("height")) imagesWithoutDimensions++;
  });

  // Scripts / styles / mixed content (performance indicators)
  let scriptsCount = 0;
  let blockingScriptsCount = 0;
  $("script[src]").each((_, el) => {
    scriptsCount++;
    const $s = $(el);
    const inHead = $s.parents("head").length > 0;
    if (inHead && $s.attr("async") === undefined && $s.attr("defer") === undefined && $s.attr("type") !== "module") blockingScriptsCount++;
  });
  const stylesheetsCount = $('link[rel~="stylesheet"]').length;
  let mixedContentCount = 0;
  if (page.protocol === "https:") {
    $('img[src^="http://"], script[src^="http://"], link[rel~="stylesheet"][href^="http://"], iframe[src^="http://"], video[src^="http://"], source[src^="http://"]').each(() => {
      mixedContentCount++;
    });
  }

  // Structured data
  const schemaTypeSet = new Set<string>();
  let schemaErrors = 0;
  const jsonLdRoots: unknown[] = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw.trim()) return;
    try {
      const parsed: unknown = JSON.parse(raw);
      jsonLdRoots.push(parsed);
      collectSchemaTypes(parsed, schemaTypeSet);
    } catch {
      schemaErrors++;
    }
  });
  $("[itemtype]").each((_, el) => {
    const t = ($(el).attr("itemtype") ?? "").split("/").pop();
    if (t) schemaTypeSet.add(t);
  });

  // Open Graph / Twitter
  const openGraph: Record<string, string> = {};
  $("meta[property], meta[name]").each((_, el) => {
    const key = ($(el).attr("property") ?? $(el).attr("name") ?? "").toLowerCase();
    if (key.startsWith("og:") && !(key in openGraph)) openGraph[key] = cleanText($(el).attr("content"), 500);
  });
  const twitterCard = Boolean(metaByName("twitter:card"));

  // Client-side redirects: <meta http-equiv="refresh"> or a script that only sets location.
  let clientRedirect: PageData["clientRedirect"] = null;
  $("meta[http-equiv]").each((_, el) => {
    if (clientRedirect || ($(el).attr("http-equiv") ?? "").toLowerCase() !== "refresh") return;
    const m = /url\s*=\s*['"]?([^'";]+)/i.exec($(el).attr("content") ?? "");
    const r = m ? resolveHref(m[1], resolvedBase) : null;
    if (r) clientRedirect = { type: "meta", target: r.toString() };
  });
  if (!clientRedirect && wordCount < 50) {
    $("script:not([src])").each((_, el) => {
      if (clientRedirect) return;
      const m = /(?:window\.|document\.|top\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|location\.(?:replace|assign)\(\s*['"]([^'"]+)['"]/.exec($(el).contents().text());
      const target = m?.[1] ?? m?.[2];
      const r = target ? resolveHref(target, resolvedBase) : null;
      if (r) clientRedirect = { type: "script", target: r.toString() };
    });
  }

  // hreflang alternates (in the head or, on some platforms, the body).
  const hreflang: PageData["hreflang"] = [];
  $("link[rel][hreflang]").each((_, el) => {
    if (hreflang.length >= MAX_HREFLANG) return false;
    if (!($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate")) return;
    const lang = cleanText($(el).attr("hreflang"), 40);
    const href = $(el).attr("href");
    const r = href ? resolveHref(href, resolvedBase) : null;
    if (lang && r) hreflang.push({ lang, href: r.toString() });
  });

  // Main content: visible text without navigation, header and footer, where mega-menus
  // ("Cars under $15,000") and disclaimers would otherwise read as this vehicle's price or status.
  const $main = $("body").clone();
  $main.find('script, style, noscript, template, svg, iframe, header, footer, nav, [role="navigation"], [role="banner"], [role="contentinfo"]').remove();
  // A space after every element, so "VIN …</dd><button>Call for price" does not run together into one word.
  $main.find("*").after(" ");
  const mainText = cleanText($main.text(), 400_000);

  // Vehicle facts. Cheap to compute on every page; stored only for vehicle detail pages.
  const vehicleNodes: Array<Record<string, unknown>> = [];
  for (const r of jsonLdRoots) collectVehicleNodes(r, vehicleNodes);
  let schemaPrice: number | null = null;
  let availability: string | null = null;
  let schemaVin: string | null = null;
  for (const n of vehicleNodes) {
    const o = offerFacts(n);
    schemaPrice ??= o.price;
    availability ??= o.availability;
    const vin = str(n.vehicleIdentificationNumber, 40) ?? str(n.sku, 40);
    if (!schemaVin && vin && looksLikeVin(vin)) schemaVin = vin.toUpperCase();
  }
  const microPrice = $("[itemprop=price]").first();
  schemaPrice ??= parseAmount(microPrice.attr("content") ?? microPrice.text());
  schemaPrice ??= parseAmount(metaByName("product:price:amount") ?? $('meta[property="product:price:amount"], meta[property="og:price:amount"]').first().attr("content"));
  availability ??= lastSegment($("[itemprop=availability]").first().attr("href") ?? $("[itemprop=availability]").first().attr("content"));
  const amounts = (re: RegExp, text: string) => [...text.matchAll(re)].some((m) => (parseAmount(m[1]) ?? 0) >= 1000 && (parseAmount(m[1]) ?? 0) <= 2_000_000);
  let scriptPrice = false;
  $("script:not([src])").each((_, el) => {
    if (scriptPrice || ($(el).attr("type") ?? "").includes("ld+json")) return;
    scriptPrice = amounts(SCRIPT_PRICE_RE, $(el).contents().text().slice(0, 500_000));
  });
  const urlVin = page.pathname.split(/[^A-Za-z0-9]+/).find(looksLikeVin);
  const textVin = LABELLED_VIN_RE.exec(mainText)?.[1];
  const vehicle: VehiclePageFacts = {
    vin: schemaVin ?? (textVin && looksLikeVin(textVin) ? textVin.toUpperCase() : null) ?? urlVin?.toUpperCase() ?? null,
    hasVehicleSchema: vehicleNodes.length > 0 || [...schemaTypeSet].some((t) => VEHICLE_SCHEMA_TYPES.includes(t)),
    schemaPrice,
    visiblePrice: amounts(PRICE_RE, mainText),
    scriptPrice,
    priceStatement: PRICE_STATEMENT_RE.test(mainText),
    availability,
    soldText: SOLD_RE.test(mainText),
  };

  // Name / address / phone. Visible numbers are evidence only (sales, service and parts lines differ legitimately).
  const visiblePhones: string[] = [];
  const addPhone = (p: string | null) => {
    if (p && !visiblePhones.includes(p) && visiblePhones.length < MAX_VISIBLE_PHONES) visiblePhones.push(p);
  };
  $('a[href^="tel:"], a[href^="TEL:"]').each((_, el) => addPhone(normalizePhone(($(el).attr("href") ?? "").slice(4))));
  $("header, footer").each((_, el) => {
    for (const m of cleanText($(el).text(), 20_000).matchAll(US_PHONE_RE)) addPhone(`${m[1]}${m[2]}${m[3]}`);
  });
  const napEntities = collectNapEntities(jsonLdRoots);
  const nap = napEntities.length || visiblePhones.length ? { entities: napEntities, visiblePhones } : null;

  return {
    title,
    metaDescription,
    h1,
    h2,
    canonical,
    robotsMeta,
    lang,
    hasViewport,
    wordCount,
    links,
    internalLinksCount: links.filter((l) => l.isInternal).length,
    externalLinksCount: links.filter((l) => !l.isInternal).length,
    imagesCount,
    imagesMissingAlt,
    imagesMissingAltSamples,
    imagesWithoutDimensions,
    scriptsCount,
    blockingScriptsCount,
    stylesheetsCount,
    mixedContentCount,
    schemaTypes: [...schemaTypeSet].slice(0, 30),
    schemaErrors,
    openGraph,
    twitterCard,
    clientRedirect,
    hreflang,
    vehicle,
    nap,
  };
}
