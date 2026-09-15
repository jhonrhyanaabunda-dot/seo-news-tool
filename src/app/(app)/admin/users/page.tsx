import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth/guards";
import { env } from "@/lib/env";
import { getUsers } from "@/lib/queries/system";
import { updateUserAction } from "@/app/actions/users";
import { CreateUserForm, ResetPasswordForm } from "@/components/admin/user-forms";
import { SubmitButton } from "@/components/client/submit-button";
import { Badge, Card, PageHeader, TableWrap } from "@/components/ui";
import { fmtDateTime } from "@/components/format";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

export default async function UsersPage() {
  const me = await requireAdmin();
  const list = await getUsers();
  const tz = env().APP_TIMEZONE;
  return (
    <>
      <PageHeader title="Users" description="Who can sign in. Viewers can review reports and news; administrators also manage dealerships, settings and users." />
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <TableWrap caption="User accounts">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Role</th>
                <th scope="col">Last sign-in</th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {list.map((u) => (
                <tr key={u.id}>
                  <td>
                    <div className="font-medium text-slate-900">
                      {u.name} {u.id === me.id && <span className="text-xs text-slate-500">(you)</span>}
                    </div>
                    <div className="text-xs text-slate-500">{u.email}</div>
                    {!u.isActive && <Badge tone="critical">Deactivated</Badge>}
                  </td>
                  <td>{u.role === "admin" ? <Badge tone="accent">Administrator</Badge> : <Badge>Viewer</Badge>}</td>
                  <td className="whitespace-nowrap text-slate-600">{fmtDateTime(u.lastLoginAt, tz)}</td>
                  <td>
                    {u.id !== me.id && (
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <form action={updateUserAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <SubmitButton className="btn btn-sm" name="op" value={u.role === "admin" ? "make-viewer" : "make-admin"} pendingText="…">
                            {u.role === "admin" ? "Make viewer" : "Make admin"}
                          </SubmitButton>
                        </form>
                        <form action={updateUserAction}>
                          <input type="hidden" name="userId" value={u.id} />
                          <SubmitButton className={u.isActive ? "btn-danger btn-sm" : "btn btn-sm"} name="op" value={u.isActive ? "deactivate" : "activate"} confirm={u.isActive ? `Deactivate ${u.email}? They will be signed out immediately.` : undefined} pendingText="…">
                            {u.isActive ? "Deactivate" : "Activate"}
                          </SubmitButton>
                        </form>
                        <ResetPasswordForm userId={u.id} />
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
        <Card title="Add a user">
          <CreateUserForm />
        </Card>
      </div>
    </>
  );
}
