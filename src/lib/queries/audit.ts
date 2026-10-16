import "server-only";
import { and, desc, eq, isNotNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { auditLogs, users } from "@/lib/db/schema";
import { AUDIT_PAGE_SIZE, type AuditFilters } from "@/lib/audit-shared";

/** One page of the audit trail, newest first, with the total for paging. */
export async function getAuditLog(f: AuditFilters) {
  const conds: SQL[] = [];
  if (f.action) conds.push(eq(auditLogs.action, f.action));
  if (f.actor) conds.push(eq(auditLogs.actorUserId, f.actor));
  const where = conds.length ? and(...conds) : undefined;
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
      .limit(AUDIT_PAGE_SIZE)
      .offset((f.page - 1) * AUDIT_PAGE_SIZE),
    db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(where),
  ]);
  return { rows, total: total?.n ?? 0 };
}

/** People who appear as actors, for the filter list (current accounts only; deleted ones keep their email on the row). */
export async function getAuditActors() {
  return db
    .selectDistinct({ id: users.id, email: users.email, name: users.name })
    .from(auditLogs)
    .innerJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(isNotNull(auditLogs.actorUserId))
    .orderBy(users.email)
    .limit(500);
}
