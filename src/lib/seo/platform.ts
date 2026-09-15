/**
 * Recognise the dealership website platform from the homepage markup the
 * crawler already downloaded (no extra requests). Pure function.
 *
 * Useful operationally: sites on the same platform share templates, the same
 * SEO problems and usually the same bot-protection setup, so "which provider do
 * I ask to allow-list the crawler?" becomes a filter instead of a hunt.
 */
const PLATFORMS: Array<{ name: string; pattern: RegExp }> = [
  // Dealer-specific platforms first: several of them are built on WordPress.
  { name: "Dealer Inspire", pattern: /dealerinspire|class="di-cf-|\/di-uploads\//i },
  { name: "Dealer.com", pattern: /static\.dealer\.com|pictures\.dealer\.com|\bddc-site\b|DDC\.WS\b|(?<![a-z0-9-])dealer\.com\//i },
  { name: "DealerOn", pattern: /dealeron\.com|\bdealeron\b/i },
  { name: "DealerFire", pattern: /dealerfire/i },
  { name: "Dealer eProcess", pattern: /dealereprocess|dealer-eprocess/i },
  { name: "Sincro", pattern: /sincrodigital|cdkglobal/i },
  { name: "Team Velocity", pattern: /teamvelocity|apollo\.teamvelocitymarketing/i },
  { name: "Fox Dealer", pattern: /foxdealer/i },
  { name: "Dealer Venom", pattern: /dealervenom/i },
  { name: "Jazel", pattern: /jazel(auto)?\b|\.jazel\./i },
  { name: "Overfuel", pattern: /overfuel/i },
  { name: "Dealer Spike", pattern: /dealerspike/i },
  { name: "WordPress", pattern: /\/wp-content\/|\/wp-includes\/|<meta name="generator" content="WordPress/i },
];

export function detectPlatform(html: string | null | undefined): string | null {
  if (!html) return null;
  // Platform markers live in asset URLs, generator tags and class names near the top; 600 KB covers any homepage head.
  const sample = html.slice(0, 600_000);
  return PLATFORMS.find((p) => p.pattern.test(sample))?.name ?? null;
}
