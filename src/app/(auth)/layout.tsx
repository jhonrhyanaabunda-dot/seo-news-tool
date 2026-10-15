import { existsSync } from "node:fs";
import path from "node:path";
import Image from "next/image";

/**
 * Shell for the signed-out pages: a solid brand panel on the left, the card on
 * the right. Drop a photo at public/auth-hero.jpg (something A3 owns or has
 * licensed) and it is used automatically, darkened so the text stays readable.
 */
const HERO = "/auth-hero.jpg";
const heroExists = existsSync(path.join(process.cwd(), "public", "auth-hero.jpg"));

const FACTS = [
  { value: "39", label: "SEO checks on every page" },
  { value: "Daily", label: "website scans and alerts" },
  { value: "Weekly", label: "SEO and industry newsletter" },
];

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1fr]">
      <aside className="auth-hero relative hidden flex-col justify-center gap-9 overflow-hidden p-10 text-white lg:flex xl:p-14">
        {heroExists && (
          <>
            <Image src={HERO} alt="" fill priority sizes="50vw" className="object-cover" />
            <div className="absolute inset-0 bg-brand-950/80" />
          </>
        )}

        {/* The logo's lettering is black, so it sits on a white plate rather than straight on the navy. */}
        <div className="relative self-start rounded-lg bg-white px-5 py-3 shadow-[var(--shadow-raised)]">
          <Image src="/a3brands-logo.png" alt="A3 Brands" width={1388} height={879} priority className="h-20 w-auto" />
        </div>

        <div className="relative max-w-md">
          <h1 className="text-3xl font-semibold leading-tight tracking-tight xl:text-4xl">SEO &amp; News Monitor</h1>
          <p className="mt-4 text-base leading-relaxed text-blue-100/80">
            Website health, search visibility and dealership news for every A3 Brands client, checked automatically and reported in plain language.
          </p>
        </div>

        <dl className="relative grid max-w-lg grid-cols-3 gap-6 border-t border-white/10 pt-6">
          {FACTS.map((f) => (
            <div key={f.label}>
              <dt className="sr-only">{f.label}</dt>
              <dd className="text-xl font-semibold tabular-nums">{f.value}</dd>
              <dd className="mt-1 text-sm leading-snug text-blue-100/70">{f.label}</dd>
            </div>
          ))}
        </dl>
      </aside>

      <main className="auth-canvas flex items-center justify-center p-5 sm:p-8">
        <div className="auth-card w-full max-w-[26rem] rounded-xl bg-white p-7 sm:p-9">
          <div className="mb-5 flex justify-center">
            <Image src="/a3brands-logo.png" alt="A3 Brands" width={1388} height={879} priority className="h-16 w-auto" />
          </div>
          {children}
        </div>
      </main>
    </div>
  );
}
