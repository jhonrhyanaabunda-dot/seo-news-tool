"use server";

import { revalidatePath } from "next/cache";
import { assertUser } from "@/lib/auth/guards";
import { markWelcomeDismissed } from "@/lib/queries/onboarding";

/**
 * "Got it" on the welcome guide. Only ever marks the signed-in user's own row;
 * the guide stays available under Help. No redirect: the reader stays on the
 * page they were on, which re-renders without the guide.
 */
export async function dismissWelcomeAction() {
  const user = await assertUser();
  await markWelcomeDismissed(user.id);
  revalidatePath("/", "layout");
}
