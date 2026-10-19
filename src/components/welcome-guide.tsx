import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { dismissWelcomeAction } from "@/app/actions/onboarding";
import { SubmitButton } from "@/components/client/submit-button";

/**
 * The first-visit guide for dealership logins, in plain language. Shown once
 * (until "Got it"), and always available on the Help page.
 *
 * Every statement here describes how the product actually behaves; it links
 * to the place where the reader can see it rather than paraphrasing numbers.
 */
export function WelcomeGuide({ dealershipId, dismissible }: { dealershipId: number | null; dismissible: boolean }) {
  const base = dealershipId ? `/dealerships/${dealershipId}` : "/";
  const items: Array<{ title: string; body: string; href: string; link: string }> = [
    {
      title: "Your SEO health score",
      body: "A score from 0 to 100 for how well your website follows search-engine best practice: 85 and above is good, 65–84 needs improvement, below 65 is poor. It is calculated by fixed rules from what our regular website check finds — the same check always gives the same score.",
      href: base,
      link: "See your score",
    },
    {
      title: "Opportunities: what to do next",
      body: "The problems our check found, most important first, each with what to change. Hand this list to your website provider. When a fix goes live, the next check confirms it and the score updates.",
      href: dealershipId ? `${base}?tab=opportunities` : "/",
      link: "Open opportunities",
    },
    {
      title: "Pages we could not check",
      body: "Some websites' security blocks automated checks on some pages. Those pages are shown as “could not be checked” and are never counted as SEO problems. Your website provider can allow our checker (A3SEOMonitor) if you want them included.",
      href: base,
      link: "See website coverage",
    },
    {
      title: "Findings and their status",
      body: "Every individual finding, page by page. A3 marks findings as in progress, fixed or ignored as work happens; a fix shows as verified once a later check no longer finds it. Ignored findings still count in the score.",
      href: dealershipId ? `${base}?tab=issues` : "/",
      link: "View findings",
    },
    {
      title: "Reports and PDF",
      body: "A printable SEO report built from your latest check, which you can download as a PDF and forward. Monthly reports also appear in the Reports tab.",
      href: dealershipId ? `/report/${dealershipId}` : "/",
      link: "Open the report",
    },
    {
      title: "Email summaries",
      body: "Your contacts receive a summary when something meaningful changes, an immediate alert if the website goes down or a critical problem appears, and — when A3 turns it on — a monthly report with the PDF. Ask your A3 account manager to add or change addresses.",
      href: "/help#emails",
      link: "More about emails",
    },
  ];
  return (
    <section aria-labelledby="welcome-title" className="mb-6 rounded-lg border border-brand-100 bg-brand-50/60 p-5">
      <h2 id="welcome-title" className="text-lg font-semibold tracking-tight text-slate-900">
        Welcome to your SEO monitor
      </h2>
      <p className="mt-1 max-w-3xl text-sm text-slate-600">A3 Brands checks your website regularly and shows you, in plain language, how it is doing in search and what to fix. Here is what you will find:</p>
      <ul className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((i) => (
          <li key={i.title} className="rounded-md border border-slate-200 bg-white p-3.5">
            <h3 className="text-sm font-semibold text-slate-900">{i.title}</h3>
            <p className="mt-1 text-sm text-slate-600">{i.body}</p>
            <Link href={i.href} className="mt-2 inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
              {i.link} <ArrowRight aria-hidden className="h-3.5 w-3.5" />
            </Link>
          </li>
        ))}
      </ul>
      {dismissible && (
        <form action={dismissWelcomeAction} className="mt-4 flex flex-wrap items-center gap-3">
          <SubmitButton className="btn-primary" pendingText="Saving…">
            Got it
          </SubmitButton>
          <span className="text-xs text-slate-500">You can open this guide again any time from Help or your account page.</span>
        </form>
      )}
    </section>
  );
}
