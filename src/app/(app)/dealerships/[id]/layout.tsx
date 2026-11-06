import { notFound } from "next/navigation";
import { requireDealershipAccess } from "@/lib/auth/tenant";
import { getDealership } from "@/lib/queries/dealership";

/**
 * Authorisation for everything under /dealerships/[id].
 *
 * It lives in the layout rather than the page so the check runs *before* the
 * page's Suspense fallback is flushed. Once any markup has gone out, Next can
 * no longer set the response status, and a denied page comes back as 200 with
 * a not-found body. Throwing from here keeps the real 404.
 *
 * Existence is settled here too, so a dealership that is missing and one the
 * viewer may not see produce the same 404 — the response never confirms that an
 * id exists. The lookup is request-cached, so the page below pays nothing for it.
 */
export default async function DealershipLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dealershipId = Number(id);
  if (!Number.isInteger(dealershipId) || dealershipId <= 0) notFound();
  // Read together, because each read is a network round trip. Access is still decided before anything
  // is rendered: a refusal rejects this whole line, and the dealership it fetched goes no further.
  const [, dealer] = await Promise.all([requireDealershipAccess(dealershipId), getDealership(dealershipId)]);
  if (!dealer) notFound();
  return <>{children}</>;
}
