import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Uptime probe. Reports database connectivity, and how long ago any crawler
 * worker last checked in (so an external monitor can tell when scanning has
 * stopped) — a number only, no names or configuration.
 */
export async function GET() {
  try {
    const rows = (await db.execute(sql`
      select floor(extract(epoch from (now() - max(last_seen_at))) / 60)::int as mins from crawler_workers where kind = 'worker'
    `)) as unknown as Array<{ mins: number | null }>;
    const mins = rows[0]?.mins ?? null;
    return NextResponse.json({ ok: true, database: "up", crawler: { lastSeenMinutesAgo: mins }, time: new Date().toISOString() });
  } catch {
    return NextResponse.json({ ok: false, database: "down", time: new Date().toISOString() }, { status: 503 });
  }
}
