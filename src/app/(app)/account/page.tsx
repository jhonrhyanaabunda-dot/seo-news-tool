import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/guards";
import { adminMfaRequired, getMfaStatus } from "@/lib/auth/mfa";
import { groupSecret } from "@/lib/auth/totp";
import { env } from "@/lib/env";
import { beginMfaEnrollmentAction, cancelMfaEnrollmentAction } from "@/app/actions/mfa";
import { ChangePasswordForm } from "@/components/admin/user-forms";
import { ConfirmMfaForm, DisableMfaForm, RegenerateCodesForm } from "@/components/account/mfa-forms";
import { SubmitButton } from "@/components/client/submit-button";
import { QrCode } from "@/components/qr-code";
import { Badge, Card, Notice, PageHeader } from "@/components/ui";
import { fmtDateTime } from "@/components/format";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

const ROLE_LABEL = { admin: "Administrator", viewer: "Viewer", client: "Dealership" } as const;

export default async function AccountPage({ searchParams }: { searchParams: Promise<{ mfa?: string }> }) {
  const user = await requireUser();
  const { mfa } = await searchParams;
  const [status, required] = await Promise.all([getMfaStatus(user.id), adminMfaRequired()]);
  const mustEnroll = required && user.role === "admin" && status.state !== "on";
  return (
    <>
      {(mfa === "required" || mustEnroll) && status.state !== "on" && (
        <Notice tone="warning">
          <strong>Two-factor sign-in is required for administrators.</strong> Set it up below to use the admin pages again.
        </Notice>
      )}
      <PageHeader title="Your account" description={`${user.name} · ${user.email} · ${ROLE_LABEL[user.role]}`} />
      <div className="max-w-xl space-y-5">
        <Card title="Change password">
          <ChangePasswordForm />
        </Card>

        <section id="two-factor" className="scroll-mt-6">
          <Card
            title="Two-factor sign-in"
            description="After your password, sign-in asks for a 6-digit code from an authenticator app on your phone (Google Authenticator, Microsoft Authenticator, 1Password, Authy…)."
            actions={status.state === "on" ? <Badge tone="success" dot>On</Badge> : <Badge dot>Off</Badge>}
          >
            {status.state === "off" && (
              <form action={beginMfaEnrollmentAction}>
                <SubmitButton className="btn-primary" pendingText="Preparing…">
                  Set up two-factor
                </SubmitButton>
              </form>
            )}

            {status.state === "pending" && (
              <div className="space-y-5">
                <ol className="list-decimal space-y-4 pl-5 text-sm text-slate-700">
                  <li>
                    <p>In your authenticator app, add an account and scan this code.</p>
                    <div className="mt-3 w-48 rounded-md border border-slate-200 bg-white p-1">
                      <QrCode text={status.uri} label="QR code for setting up two-factor sign-in" className="h-auto w-full" />
                    </div>
                    <details className="mt-3">
                      <summary className="cursor-pointer text-sm font-medium text-brand-700 hover:underline">Can’t scan? Enter the key by hand</summary>
                      <div className="mt-2 space-y-2 text-sm">
                        <p>
                          Choose “Enter a setup key”, use <strong>A3 SEO Monitor</strong> as the name and your email as the account, and type this key (spaces are optional). Choose “Time-based” if asked.
                        </p>
                        <p>
                          <code className="select-all break-all rounded bg-slate-100 px-2 py-1 font-mono text-[15px] tracking-wider text-slate-900">{groupSecret(status.secret)}</code>
                        </p>
                        <p className="text-xs text-slate-500">
                          On the phone itself, this link opens most authenticator apps directly:{" "}
                          <a href={status.uri} className="break-all text-brand-700 underline">
                            add to authenticator
                          </a>
                        </p>
                      </div>
                    </details>
                  </li>
                  <li>
                    <p className="mb-2">Enter the 6-digit code the app now shows.</p>
                    <ConfirmMfaForm />
                  </li>
                </ol>
                <form action={cancelMfaEnrollmentAction} className="border-t border-slate-100 pt-4">
                  <SubmitButton className="btn btn-sm" pendingText="…">
                    Cancel setup
                  </SubmitButton>
                </form>
              </div>
            )}

            {status.state === "on" && (
              <div className="space-y-5 text-sm text-slate-700">
                <p>
                  On since {fmtDateTime(status.enabledAt, env().APP_TIMEZONE)}. {status.recoveryCodesLeft} of 10 recovery codes left.
                </p>
                {status.recoveryCodesLeft <= 3 && <Notice tone="warning">You are running low on recovery codes. Generate a new set below.</Notice>}
                <div>
                  <h3 className="mb-2 font-semibold text-slate-900">Recovery codes</h3>
                  <RegenerateCodesForm />
                </div>
                <div className="border-t border-slate-100 pt-4">
                  <h3 className="mb-1 font-semibold text-slate-900">Turn off</h3>
                  {required && user.role === "admin" && <p className="mb-2 text-xs text-amber-800">Two-factor is required for administrators: turning it off blocks the admin pages until you set it up again.</p>}
                  <DisableMfaForm />
                </div>
              </div>
            )}
          </Card>
        </section>
      </div>
    </>
  );
}
