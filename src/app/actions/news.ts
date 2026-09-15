"use server";

import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { assertUser } from "@/lib/auth/guards";
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
    .where(eq(newsArticles.id, parsed.data.articleId));
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
    .where(inArray(newsArticles.id, ids.data));
  revalidatePath("/news");
  revalidatePath("/", "layout");
}
