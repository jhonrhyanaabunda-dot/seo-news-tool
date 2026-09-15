import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Uptime probe. Reports database connectivity only — no configuration details. */
export async function GET() {
  try {
    await db.execute(sql`select 1`);
    return NextResponse.json({ ok: true, database: "up", time: new Date().toISOString() });
  } catch {
    return NextResponse.json({ ok: false, database: "down", time: new Date().toISOString() }, { status: 503 });
  }
}
