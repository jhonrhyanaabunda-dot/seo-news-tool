import type { Metadata } from "next";

export const metadata: Metadata = { title: "A3SEOMonitor crawler", robots: { index: false } };

/** Public page linked from the crawler's User-Agent, so website operators know who is visiting. */
export default function BotPage() {
  return (
    <main className="mx-auto max-w-2xl px-6 py-12 text-slate-800">
      <h1 className="text-2xl font-semibold">A3SEOMonitor crawler</h1>
      <p className="mt-4">
        <strong>A3SEOMonitor</strong> is the website quality monitor used by A3 Brands to check the SEO health of the dealership websites it supports: page titles, meta descriptions,
        headings, broken links, structured data and similar technical checks.
      </p>
      <h2 className="mt-8 text-lg font-semibold">How it behaves</h2>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        <li>Identifies itself with the User-Agent token <code>A3SEOMonitor</code>.</li>
        <li>Respects robots.txt, including <code>Crawl-delay</code>.</li>
        <li>Fetches one page at a time per website, with a pause between requests, and a limited number of pages per scan.</li>
        <li>Never attempts to bypass CAPTCHAs, Cloudflare challenges or other security controls. If access is refused or rate-limited it stops and does not retry.</li>
        <li>Runs from cloud servers in the United States.</li>
      </ul>
      <h2 className="mt-8 text-lg font-semibold">Controlling access</h2>
      <p className="mt-2">To exclude it, add to robots.txt:</p>
      <pre className="mt-2 rounded bg-slate-100 p-3 text-sm">User-agent: A3SEOMonitor{"\n"}Disallow: /</pre>
      <p className="mt-4">To allow it through a firewall, allow-list requests whose User-Agent contains <code>A3SEOMonitor</code>, or contact your A3 Brands account team.</p>
    </main>
  );
}
