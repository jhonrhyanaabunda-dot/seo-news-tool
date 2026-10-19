import type { Metadata } from "next";
import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import QRCode from "qrcode";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { requireUser } from "@/lib/auth/guards";
import { TOTP_SETUP_COOKIE, decryptTotpSecret, otpauthUrl } from "@/lib/auth/totp";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { env } from "@/lib/env";
import { cancelTwoFactorSetupAction, startTwoFactorSetupAction } from "@/app/actions/two-factor";
import { ChangePasswordForm } from "@/components/admin/user-forms";
import { ConfirmSetupForm, DisableForm, RegenerateCodesForm } from "@/components/account/two-factor-forms";
import { Badge, Card, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/components/format";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

const ROLE_LABEL = { admin: "Administrator", client: "Dealership", viewer: "Viewer" } as const;

export default async function AccountPage() {
  const user = await requireUser();
  const [row] = await db
    .select({ totpEnabledAt: users.totpEnabledAt, recovery: users.totpRecoveryHashes })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const enabledAt = row?.totpEnabledAt ?? null;

  // A setup in progress: the encrypted secret sits in a short-lived cookie until the first code confirms it.
  let setup: { qr: string; key: string } | null = null;
  const pending = (await cookies()).get(TOTP_SETUP_COOKIE)?.value;
  if (!enabledAt && pending) {
    try {
      const secret = decryptTotpSecret(pending, env().AUTH_SECRET);
      setup = { qr: await QRCode.toDataURL(otpauthUrl(secret, user.email), { margin: 1, width: 200 }), key: secret.match(/.{1,4}/g)!.join(" ") };
    } catch {
      setup = null;
    }
  }

  return (
    <>
      <PageHeader title="Your account" description={`${user.name} · ${user.email} · ${ROLE_LABEL[user.role as keyof typeof ROLE_LABEL] ?? user.role}`} />
      <div className="max-w-2xl space-y-5">
        <Card title="Change password">
          <ChangePasswordForm />
        </Card>

        <section id="two-factor" className="scroll-mt-6">
          <Card
            title="Two-factor login"
            description="A 6-digit code from an authenticator app on your phone, asked for after your password."
            actions={enabledAt ? <Badge tone="success" dot>On</Badge> : <Badge dot>Off</Badge>}
          >
            {enabledAt ? (
              <div className="space-y-6 text-sm">
                <p className="flex items-start gap-2 text-slate-700">
                  <ShieldCheck aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                  <span>
                    On since {fmtDateTime(enabledAt, env().APP_TIMEZONE)}. {row?.recovery?.length ?? 0} of 10 recovery codes unused.
                  </span>
                </p>
                <div>
                  <h3 className="mb-2 font-medium text-slate-900">New recovery codes</h3>
                  <RegenerateCodesForm />
                </div>
                <div>
                  <h3 className="mb-2 font-medium text-slate-900">Turn off two-factor login</h3>
                  <DisableForm />
                </div>
              </div>
            ) : setup ? (
              <div className="space-y-5 text-sm">
                <ol className="list-decimal space-y-1 pl-5 text-slate-700">
                  <li>Open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…).</li>
                  <li>Scan this code, or type the key by hand.</li>
                  <li>Enter the 6-digit code the app shows.</li>
                </ol>
                <div className="flex flex-wrap items-center gap-6">
                  {/* eslint-disable-next-line @next/next/no-img-element -- a generated data URL, nothing to optimise */}
                  <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} className="rounded-md border border-slate-200" />
                  <div>
                    <div className="eyebrow">Key</div>
                    <code className="mt-1 block select-all font-mono text-[15px] tracking-wider text-slate-900">{setup.key}</code>
                  </div>
                </div>
                <ConfirmSetupForm />
                <form action={cancelTwoFactorSetupAction}>
                  <button type="submit" className="text-sm text-slate-500 hover:text-slate-800">
                    Cancel setup
                  </button>
                </form>
              </div>
            ) : (
              <form action={startTwoFactorSetupAction} className="space-y-3 text-sm">
                <p className="text-slate-600">
                  {user.role === "admin" ? "Recommended for administrators: it keeps the account safe even if the password leaks." : "Adds a second check to your sign-in."}
                </p>
                <button type="submit" className="btn-primary">
                  Set up two-factor login
                </button>
              </form>
            )}
          </Card>
        </section>

        {/* Product track (onboarding): the welcome guide can be reopened at any time. */}
        <Card title="Help">
          <p className="text-sm text-slate-600">What the score means, where to find what to fix, reports and PDFs, and which emails you receive.</p>
          <Link href="/help" className="btn mt-3">
            Open the welcome guide
          </Link>
        </Card>
      </div>
    </>
  );
}
