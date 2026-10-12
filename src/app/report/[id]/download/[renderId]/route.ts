import { NextResponse } from "next/server";
import { assertDealershipAccess } from "@/lib/auth/tenant";
import { AuthError } from "@/lib/auth/guards";
import { takeRenderedPdf } from "@/lib/reports/request-pdf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Hand the finished PDF to the person who asked for it.
 *
 * Both ids come from the URL and neither is trusted: the dealership is checked
 * against the caller's session, and the render must belong to that dealership.
 * A render that is missing, unfinished or someone else's is reported as 404,
 * the same answer an unauthorised dealership gets anywhere else, so the
 * response never confirms that another dealership's report exists.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string; renderId: string }> }) {
  const { id, renderId } = await params;
  const dealershipId = Number(id);
  const render = Number(renderId);
  if (!Number.isInteger(dealershipId) || dealershipId <= 0 || !Number.isInteger(render) || render <= 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    await assertDealershipAccess(dealershipId);
  } catch (err) {
    // 401 when signed out, 404 rather than 403 when signed in, so the answer
    // is identical whether or not the dealership exists.
    return new NextResponse("Not found", { status: err instanceof AuthError && err.status === 401 ? 401 : 404 });
  }

  const file = await takeRenderedPdf(render, dealershipId);
  if (!file) return new NextResponse("Not found", { status: 404 });

  return new NextResponse(new Uint8Array(file.pdf), {
    headers: {
      "content-type": "application/pdf",
      // The filename is built server-side from the dealership name and is
      // already stripped of anything a path could use.
      "content-disposition": `attachment; filename="${file.filename}"`,
      "content-length": String(file.pdf.length),
      "cache-control": "no-store",
    },
  });
}
