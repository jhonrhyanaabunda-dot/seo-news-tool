import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth/guards";
import { isClient } from "@/lib/auth/tenant";

/**
 * The industry feed is A3's own trade reading, not a dealership deliverable.
 * Checked in the layout so a dealership login gets a real 404 rather than a 200
 * carrying a not-found body; see the admin layout for why that matters.
 */
export default async function SeoNewsLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  if (isClient(user)) notFound();
  return <>{children}</>;
}
