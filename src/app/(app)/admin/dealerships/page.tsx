import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { requireAdmin } from "@/lib/auth/guards";
import { getDealerRows } from "@/lib/queries/dashboard";
import { Badge, EmptyState, Notice, PageHeader, TableWrap } from "@/components/ui";
import { displayUrl } from "@/components/format";

export const metadata: Metadata = { title: "Manage dealerships" };
export const dynamic = "force-dynamic";

export default async function AdminDealershipsPage({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  await requireAdmin();
  const { deleted } = await searchParams;
  const rows = await getDealerRows();
  return (
    <>
      {deleted && <Notice tone="success">Dealership removed, along with its scan history and news.</Notice>}
      <PageHeader
        title="Dealerships"
        description="Add, edit or remove monitored dealerships. Changes apply to the next scheduled scan automatically."
        actions={
          <Link href="/admin/dealerships/new" className="btn-primary">
            <Plus aria-hidden className="h-4 w-4" /> Add dealership
          </Link>
        }
      />
      {rows.length === 0 ? (
        <EmptyState title="No dealerships yet" action={<Link href="/admin/dealerships/new" className="btn-primary">Add dealership</Link>} />
      ) : (
        <TableWrap caption="Monitored dealerships">
          <thead>
            <tr>
              <th scope="col">Dealership</th>
              <th scope="col">Website</th>
              <th scope="col">Brand</th>
              <th scope="col">Location</th>
              <th scope="col">Monitoring</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <Link href={`/dealerships/${r.id}`} className="font-medium text-slate-900 hover:underline">
                    {r.name}
                  </Link>
                  {!r.isActive && (
                    <span className="ml-2">
                      <Badge>Inactive</Badge>
                    </span>
                  )}
                </td>
                <td className="text-slate-600">{displayUrl(r.websiteUrl)}</td>
                <td>{r.brand}</td>
                <td className="text-slate-600">{[r.city, r.state].filter(Boolean).join(", ") || "—"}</td>
                <td>
                  <div className="flex gap-1">
                    <Badge tone={r.seoEnabled ? "success" : "neutral"}>SEO {r.seoEnabled ? "on" : "off"}</Badge>
                    <Badge tone={r.newsEnabled ? "success" : "neutral"}>News {r.newsEnabled ? "on" : "off"}</Badge>
                  </div>
                </td>
                <td className="text-right">
                  <Link href={`/admin/dealerships/${r.id}/edit`} className="btn btn-sm">
                    Edit
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
    </>
  );
}
