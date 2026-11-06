import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth/session";
import { canAccessDealership } from "@/lib/auth/tenant";
import { ACTIVE_SCAN_STATUSES, getLatestScanAttempt, getScanProgress } from "@/lib/queries/dealership";

export const dynamic = "force-dynamic";

/**
 * Progress of a running scan, for the banner on the dealership page. The banner
 * polls this rather than re-rendering the page, which costs a dozen queries.
 * A dealership the user may not see answers exactly like one that does not exist.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dealershipId = Number(id);
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  if (!Number.isInteger(dealershipId) || dealershipId <= 0 || !(await canAccessDealership(user, dealershipId))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const attempt = await getLatestScanAttempt(dealershipId);
  if (!attempt || !ACTIVE_SCAN_STATUSES.includes(attempt.status)) return NextResponse.json({ active: false }, { headers: { "Cache-Control": "no-store" } });
  const progress = await getScanProgress(attempt.id);
  return NextResponse.json({ active: true, scanId: attempt.id, status: attempt.status, crawlPhase: attempt.crawlPhase, stalled: attempt.stalled, done: progress.done, total: progress.total }, { headers: { "Cache-Control": "no-store" } });
}
