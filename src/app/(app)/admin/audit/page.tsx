import type { Metadata } from "next";
import Link from "next/link";
import { requireAdmin } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { AUDIT_ACTIONS, AUDIT_PAGE_SIZE, auditActionLabel, auditHref, parseAuditFilters } from "@/lib/audit-shared";
import { AUDIT_RETENTION_DAYS } from "@/lib/audit";
import { getAuditActors, getAuditLog } from "@/lib/queries/audit";
import { Badge, Card, PageHeader, Pagination, TableWrap, type Tone } from "@/components/ui";
import { fmtDateTime } from "@/components/format";

export const metadata: Metadata = { title: "Audit log" };
export const dynamic = "force-dynamic";

function actionTone(action: string): Tone {
  if (action === "auth.sign_in_failed" || action === "auth.mfa_failed") return "warning";
  if (action.endsWith(".delete") || action === "user.deactivate" || action === "mfa.disabled" || action === "mfa.reset_by_admin" || action === "auth.recovery_code_used") return "critical";
  if (action.startsWith("auth.") || action.startsWith("mfa.")) return "info";
  return "neutral";
}

export default async function AuditPage({ searchParams }: { searchParams: Promise<{ page?: string; action?: string; actor?: string }> }) {
  await requireAdmin();
  const filters = parseAuditFilters(await searchParams);
  const [{ rows, total }, actors] = await Promise.all([getAuditLog(filters), getAuditActors()]);
  const totalPages = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const tz = env().APP_TIMEZONE;
  const filtered = Boolean(filters.action || filters.actor);
  return (
    <>
      <PageHeader title="Audit log" description={`Who changed what: sign-ins, two-factor, users, dealerships, settings, feeds, scans and reports. Kept for ${AUDIT_RETENTION_DAYS} days.`} />
      <Card className="mb-5" bodyClassName="p-4">
        <form method="get" action="/admin/audit" className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="audit-action" className="label">
              Action
            </label>
            <select id="audit-action" name="action" defaultValue={filters.action ?? ""} className="input">
              <option value="">All actions</option>
              {Object.entries(AUDIT_ACTIONS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="audit-actor" className="label">
              User
            </label>
            <select id="audit-actor" name="actor" defaultValue={filters.actor ? String(filters.actor) : ""} className="input">
              <option value="">Everyone</option>
              {actors.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ({a.email})
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn">
            Filter
          </button>
          {filtered && (
            <Link href="/admin/audit" className="btn">
              Clear
            </Link>
          )}
        </form>
      </Card>
      <TableWrap caption="Audit log">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Who</th>
            <th scope="col">Action</th>
            <th scope="col">Details</th>
            <th scope="col">From</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="py-5 text-center text-slate-500">
                {filtered ? "Nothing matches these filters." : "Nothing recorded yet."}
              </td>
            </tr>
          )}
          {rows.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap text-slate-600">{fmtDateTime(r.createdAt, tz)}</td>
              <td className="max-w-[16rem] break-words">
                {r.actorUserId ? (
                  <Link href={auditHref({ ...filters, actor: r.actorUserId, page: 1 })} className="text-brand-700 hover:underline">
                    {r.actorEmail ?? `User #${r.actorUserId}`}
                  </Link>
                ) : (
                  <span className="text-slate-600">{r.actorEmail ?? "—"}</span>
                )}
              </td>
              <td className="whitespace-nowrap">
                <Link href={auditHref({ ...filters, action: r.action, page: 1 })} title={r.action}>
                  <Badge tone={actionTone(r.action)}>{auditActionLabel(r.action)}</Badge>
                </Link>
              </td>
              <td className="max-w-xl">
                {r.summary}
                {r.targetType && (
                  <span className="ml-1 text-xs text-slate-500">
                    · {r.targetType}
                    {r.targetId ? ` #${r.targetId}` : ""}
                  </span>
                )}
                {r.details && Object.keys(r.details).length > 0 && (
                  <details className="mt-1">
                    <summary className="cursor-pointer text-xs text-slate-500">More</summary>
                    <pre className="mt-1 max-w-xl overflow-x-auto whitespace-pre-wrap break-words rounded bg-slate-50 p-2 text-xs text-slate-700">{JSON.stringify(r.details, null, 2)}</pre>
                  </details>
                )}
              </td>
              <td className="text-xs text-slate-500">
                <div className="font-mono">{r.ip ?? "—"}</div>
                {r.userAgent && (
                  <div className="max-w-[14rem] truncate" title={r.userAgent}>
                    {r.userAgent}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </TableWrap>
      <Pagination page={Math.min(filters.page, totalPages)} totalPages={totalPages} hrefFor={(p) => auditHref({ ...filters, page: p })} />
    </>
  );
}
