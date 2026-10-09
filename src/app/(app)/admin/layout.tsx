import { requireAdmin } from "@/lib/auth/guards";

/**
 * Administrator gate for every /admin route.
 *
 * The check belongs here rather than only in each page: a layout renders
 * outside its segment's Suspense fallback, so the redirect still reaches the
 * browser as a redirect. Inside the fallback the markup has already been
 * flushed and the response is a 200 with redirect instructions in the payload.
 * The pages keep their own `requireAdmin` as well — two cheap cached checks are
 * worth more than one that someone can delete by accident.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
