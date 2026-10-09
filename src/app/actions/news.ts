"use server";

import { revalidatePath } from "next/cache";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { assertUser } from "@/lib/auth/guards";
import { accessibleDealershipIds } from "@/lib/auth/tenant";
import { allowedFilter } from "@/lib/queries/scope";
import { db } from "@/lib/db";
import { newsArticles } from "@/lib/db/schema";

const schema = z.object({
  articleId: z.coerce.number().int().positive(),
  status: z.enum(["new", "relevant", "not_relevant", "reviewed"]),
});

/** Mark an article Relevant / Not relevant / Reviewed (any signed-in reviewer). */
export async function setArticleStatusAction(formData: FormData) {
  const user = await assertUser();
  const parsed = schema.safeParse({ articleId: formData.get("articleId"), status: formData.get("status") });
  if (!parsed.success) return;
  await db
    .update(newsArticles)
    .set({
      relevance: parsed.data.status,
      reviewedBy: user.id,
      reviewedAt: new Date(),
      // A reviewer marking brand context "Relevant" is saying it matters to this store, so it joins the store's news.
      ...(parsed.data.status === "relevant" ? { scope: "dealership" as const } : {}),
    })
    // The article id comes from the page; the dealership filter decides whether
    // this user may touch it, so a foreign id updates nothing.
    .where(and(eq(newsArticles.id, parsed.data.articleId), allowedFilter(await accessibleDealershipIds(user), newsArticles.dealershipId)));
  revalidatePath("/news");
  revalidatePath("/", "layout");
}

export async function markAllReviewedAction(formData: FormData) {
  const user = await assertUser();
  const ids = z
    .array(z.coerce.number().int().positive())
    .max(200)
    .safeParse(String(formData.get("ids") ?? "").split(",").filter(Boolean));
  if (!ids.success || ids.data.length === 0) return;
  await db
    .update(newsArticles)
    .set({ relevance: "reviewed", reviewedBy: user.id, reviewedAt: new Date() })
    .where(and(inArray(newsArticles.id, ids.data), allowedFilter(await accessibleDealershipIds(user), newsArticles.dealershipId)));
  revalidatePath("/news");
  revalidatePath("/", "layout");
}
