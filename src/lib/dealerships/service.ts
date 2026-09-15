import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/lib/db";
import { dealerships, newsKeywords, RENDER_MODES, type Dealership, type RenderMode } from "@/lib/db/schema";
import { assertSafeUrl, UnsafeUrlError } from "@/lib/security/ssrf";
import { cleanText, parseEmailList } from "@/lib/security/sanitize";
import { canonicalHost } from "@/lib/seo/url";
import { env } from "@/lib/env";
import { allRegions } from "@/lib/crawler/regions";
import { looksLikeUrl } from "@/lib/news/queries";

const optionalText = (max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? cleanText(v, max) : "") || null);

const checkbox = z
  .union([z.literal("on"), z.literal("true"), z.literal("false"), z.literal(""), z.boolean()])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true");

const optionalInt = (min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v || !v.trim()) return null;
      const n = Number(v);
      if (!Number.isInteger(n) || n < min || n > max) {
        ctx.addIssue({ code: "custom", message: `Must be a whole number between ${min} and ${max}.` });
        return z.NEVER;
      }
      return n;
    });

/** Form input for creating/editing a dealership (validated server-side). */
export const dealershipFormSchema = z.object({
  name: z.string().transform((v) => cleanText(v, 200)).pipe(z.string().min(2, "Enter the dealership name.")),
  websiteUrl: z
    .string()
    .transform((v) => {
      const t = v.trim();
      return /^https?:\/\//i.test(t) ? t : `https://${t}`;
    })
    .pipe(z.string().url("Enter a valid website address, e.g. https://www.example.com").max(500)),
  brand: z.string().transform((v) => cleanText(v, 100)).pipe(z.string().min(1, "Enter the brand (e.g. BMW).")),
  // News searches and matches on this name, so a web address here finds nothing.
  dealerGroup: optionalText(200).refine((v) => !v || !looksLikeUrl(v), "Enter the group's name (e.g. Findlay Automotive Group), not a web address."),
  city: optionalText(120),
  state: optionalText(60),
  websitePlatform: optionalText(60),
  sitemapUrl: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null))
    .pipe(z.string().url("Enter the full sitemap address, e.g. https://www.example.com/sitemap.xml").max(500).nullable()),
  notificationEmails: z.string().optional().default(""),
  seoEnabled: checkbox,
  newsEnabled: checkbox,
  instantAlertsEnabled: checkbox,
  preferredRegion: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  renderMode: z
    .string()
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : "auto")),
  isActive: checkbox,
  maxPages: optionalInt(5, 500),
  scanIntervalHours: optionalInt(1, 720),
  notes: optionalText(2000),
});

export type DealershipFormErrors = Partial<Record<keyof z.input<typeof dealershipFormSchema> | "form", string>>;

export async function validateDealershipForm(
  formData: FormData,
): Promise<{ ok: true; data: Omit<typeof dealerships.$inferInsert, "id"> } | { ok: false; errors: DealershipFormErrors }> {
  const raw = Object.fromEntries(
    ["name", "websiteUrl", "brand", "dealerGroup", "city", "state", "websitePlatform", "sitemapUrl", "notificationEmails", "seoEnabled", "newsEnabled", "instantAlertsEnabled", "preferredRegion", "renderMode", "isActive", "maxPages", "scanIntervalHours", "notes"].map(
      (k) => [k, formData.get(k) ?? undefined],
    ),
  );
  const parsed = dealershipFormSchema.safeParse(raw);
  if (!parsed.success) {
    const errors: DealershipFormErrors = {};
    for (const issue of parsed.error.issues) {
      const key = String(issue.path[0] ?? "form") as keyof DealershipFormErrors;
      errors[key] ??= issue.message;
    }
    return { ok: false, errors };
  }
  const v = parsed.data;
  const emails = parseEmailList(v.notificationEmails);
  if (emails.invalid.length) return { ok: false, errors: { notificationEmails: `These addresses are not valid: ${emails.invalid.join(", ")}` } };

  if (v.preferredRegion && !allRegions(env().CRAWLER_EXTRA_REGIONS).some((r) => r.id === v.preferredRegion)) {
    return { ok: false, errors: { preferredRegion: "Choose one of the listed crawler regions." } };
  }

  if (!RENDER_MODES.includes(v.renderMode as RenderMode)) {
    return { ok: false, errors: { renderMode: "Choose one of the listed page-fetch options." } };
  }

  // SSRF guard: the site must be a public host (checked again on every fetch).
  let url: URL;
  try {
    url = (await assertSafeUrl(v.websiteUrl)).url;
  } catch (err) {
    const msg = err instanceof UnsafeUrlError ? err.message : "The website address could not be verified.";
    return { ok: false, errors: { websiteUrl: `${msg}. Please enter the dealership's public website address.` } };
  }
  url.hash = "";
  // The sitemap is fetched by the crawler, so it must belong to the same public website.
  if (v.sitemapUrl) {
    let sameSite = false;
    try {
      sameSite = canonicalHost(new URL(v.sitemapUrl).hostname) === canonicalHost(url.hostname);
    } catch {
      sameSite = false;
    }
    if (!sameSite) return { ok: false, errors: { sitemapUrl: "The sitemap must be on the dealership's own website." } };
  }
  return {
    ok: true,
    data: {
      name: v.name,
      websiteUrl: url.toString(),
      host: canonicalHost(url.hostname),
      brand: v.brand,
      dealerGroup: v.dealerGroup,
      city: v.city,
      state: v.state,
      websitePlatform: v.websitePlatform,
      sitemapUrl: v.sitemapUrl,
      notificationEmails: emails.valid,
      seoEnabled: v.seoEnabled,
      newsEnabled: v.newsEnabled,
      instantAlertsEnabled: v.instantAlertsEnabled,
      preferredRegion: v.preferredRegion,
      renderMode: v.renderMode as RenderMode,
      isActive: v.isActive,
      maxPages: v.maxPages,
      scanIntervalHours: v.scanIntervalHours,
      notes: v.notes,
    },
  };
}

const AUTO_KINDS = ["dealership", "group", "brand", "local"] as const;

/** Keep auto-generated news keywords in sync with the dealership profile. */
async function syncAutoKeywords(d: Dealership) {
  const wanted: Array<{ keyword: string; kind: (typeof AUTO_KINDS)[number] }> = [{ keyword: d.name, kind: "dealership" }];
  if (d.dealerGroup) wanted.push({ keyword: d.dealerGroup, kind: "group" });
  wanted.push({ keyword: d.brand, kind: "brand" });
  if (d.city) wanted.push({ keyword: d.city, kind: "local" });
  await db.delete(newsKeywords).where(and(eq(newsKeywords.dealershipId, d.id), inArray(newsKeywords.kind, [...AUTO_KINDS])));
  await db
    .insert(newsKeywords)
    .values(wanted.map((w) => ({ dealershipId: d.id, keyword: w.keyword, kind: w.kind })))
    .onConflictDoNothing();
}

export async function createDealership(data: Omit<typeof dealerships.$inferInsert, "id">): Promise<Dealership> {
  const [d] = await db.insert(dealerships).values(data).returning();
  await syncAutoKeywords(d);
  return d;
}

export async function updateDealership(id: number, data: Omit<typeof dealerships.$inferInsert, "id">): Promise<Dealership | null> {
  const [d] = await db
    .update(dealerships)
    .set({ ...data, updatedAt: new Date() })
    .where(eq(dealerships.id, id))
    .returning();
  if (d) await syncAutoKeywords(d);
  return d ?? null;
}

export async function deleteDealership(id: number) {
  await db.delete(dealerships).where(eq(dealerships.id, id));
}

export async function addCustomKeyword(dealershipId: number, keyword: string): Promise<string | null> {
  const k = cleanText(keyword, 200);
  if (k.length < 2) return "Keyword must be at least 2 characters.";
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(newsKeywords)
    .where(and(eq(newsKeywords.dealershipId, dealershipId), eq(newsKeywords.kind, "custom")));
  if (n >= 10) return "A dealership can have up to 10 custom keywords.";
  await db.insert(newsKeywords).values({ dealershipId, keyword: k, kind: "custom" }).onConflictDoNothing();
  return null;
}

export async function removeKeyword(dealershipId: number, keywordId: number) {
  await db.delete(newsKeywords).where(and(eq(newsKeywords.id, keywordId), eq(newsKeywords.dealershipId, dealershipId), eq(newsKeywords.kind, "custom")));
}
