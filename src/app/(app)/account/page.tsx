import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/guards";
import { ChangePasswordForm } from "@/components/admin/user-forms";
import { Card, PageHeader } from "@/components/ui";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const user = await requireUser();
  return (
    <>
      <PageHeader title="Your account" description={`${user.name} · ${user.email} · ${user.role === "admin" ? "Administrator" : "Viewer"}`} />
      <Card title="Change password" className="max-w-xl">
        <ChangePasswordForm />
      </Card>
    </>
  );
}
