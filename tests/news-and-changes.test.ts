import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTitle, scoreArticle } from "@/lib/news/relevance";
import { diffFingerprints } from "@/lib/changes/detect";

const kw = [
  { keyword: "BMW of Fort Walton Beach", kind: "dealership" as const },
  { keyword: "BMW", kind: "brand" as const },
  { keyword: "Fort Walton Beach", kind: "local" as const },
];

test("dealership mentions score highest", () => {
  const r = scoreArticle("BMW of Fort Walton Beach hosts toy drive for local families", kw);
  assert.ok(r.score >= 75, String(r.score));
  assert.ok(r.topics.includes("community"));
});

test("brand recall news is relevant; unrelated news scores zero", () => {
  assert.ok(scoreArticle("BMW recalls 20,000 SUVs over airbag issue", kw).score >= 40);
  assert.ok(scoreArticle("BMW recalls 20,000 SUVs over airbag issue", kw).score < 50, "brand-level news stays below the default alert threshold");
  assert.equal(scoreArticle("Local bakery wins regional award", kw).score, 0);
});

test("keyword matching respects word boundaries", () => {
  assert.equal(scoreArticle("The BMWX concept is not a real car", kw).matched.includes("BMW"), false);
});

test("headline normalisation removes publisher suffixes", () => {
  assert.equal(normalizeTitle("BMW unveils new X3 - Car and Driver", "Car and Driver"), "bmw unveils new x3");
  assert.equal(normalizeTitle("BMW Unveils New X3!"), normalizeTitle("bmw unveils new x3 | MotorTrend"));
});

test("fingerprint diff finds new and resolved issues by severity", () => {
  const d = diffFingerprints(["caaa", "wbbb", "iccc"], ["caaa", "cddd", "weee"]);
  assert.deepEqual(d.addedBySeverity, { c: 1, w: 1, i: 0 });
  assert.equal(d.resolved.length, 2);
  // A severity change alone is not a new issue.
  assert.equal(diffFingerprints(["wzzz"], ["czzz"]).added.length, 0);
});

test("obituaries are excluded even when a name matches", () => {
  const r = scoreArticle("Marjorie Price Ford Obituary (2026) - Gardner's Funeral Home", [{ keyword: "Price Ford", kind: "dealership" }]);
  assert.equal(r.score, 0);
});

test("syndicated copies of one story are near-duplicates; different stories are not", async () => {
  const { titleTokens, jaccard } = await import("@/lib/news/relevance");
  const t = (s: string) => titleTokens(normalizeTitle(s));
  assert.ok(jaccard(t("Ford Recalls Nearly 149,000 Mustangs Due to Possible Loss of Power"), t("Ford recalls nearly 149,000 Mustangs over power-loss risk")) >= 0.5);
  assert.ok(jaccard(t("Ford recalls nearly 149,000 Mustangs over wiring issue"), t("Ford Recalls 10,000 Vehicles Due to Piston Issue")) < 0.5);
});

test("differently-worded syndicated recall headlines are one story", async () => {
  const { titleTokens, jaccard } = await import("@/lib/news/relevance");
  const t = (s: string) => titleTokens(normalizeTitle(s));
  const a = t("Ford Mustang Recall Hits 149K Cars, Could Cause Sudden Loss of Power");
  const b = t("Ford recalls nearly 149,000 Mustang vehicles over loss of drive power risk");
  const c = t("Ford Recalls 148,663 Mustangs Due To Wiring Issue");
  const other = t("Ford Recalls 10,000 Vehicles Due to Piston Issue");
  assert.ok(jaccard(a, b) >= 0.4, `a~b ${jaccard(a, b)}`);
  assert.ok(jaccard(b, c) >= 0.4, `b~c ${jaccard(b, c)}`);
  assert.ok(jaccard(a, other) < 0.4 && jaccard(c, other) < 0.4, `other ${jaccard(c, other)}`);
});

test("city-only matches need dealership context", () => {
  const local = [{ keyword: "Charlotte", kind: "local" as const }];
  assert.equal(scoreArticle("Port Charlotte man accused of hitting SUV with bat", local).score, 0);
  assert.ok(scoreArticle("New Charlotte dealership breaks ground on expanded showroom", local).score > 0);
});

test("headlines citing the same figure are one story", async () => {
  const { titleTokens, isNearDuplicate } = await import("@/lib/news/relevance");
  const t = (s: string) => titleTokens(normalizeTitle(s));
  assert.ok(isNearDuplicate(t("BMW Recalls 27,720 Sedans, Coupes, and Convertibles for Premature Differential Wear"), t("BMW Recalls 27,720 Cars That Could Roll Away or Lose Rear-Wheel Power")));
  assert.equal(isNearDuplicate(t("BMW recalls 27,720 cars over driveshaft"), t("Toyota opens 27,720 square foot training center")), false);
});

test("brand-only stories are brand scope; stories about this store are dealership scope", () => {
  assert.equal(scoreArticle("BMW recalls 20,000 SUVs over airbag issue", kw).scope, "brand");
  assert.equal(scoreArticle("BMW of Fort Walton Beach hosts toy drive for local families", kw).scope, "dealership");
  assert.equal(scoreArticle("Man arrested for alleged burglary, car theft at Fort Walton Beach dealership", kw).scope, "dealership");
});

test("a custom keyword for the store's trading name matches as dealership news", () => {
  const subaru = [
    { keyword: "Findlay Subaru of Las Vegas", kind: "dealership" as const },
    { keyword: "Subaru of Las Vegas", kind: "custom" as const },
    { keyword: "Subaru", kind: "brand" as const },
    { keyword: "Las Vegas", kind: "local" as const },
  ];
  const r = scoreArticle("Subaru of Las Vegas surprises elementary school teachers with $15K contribution - KSNV", subaru);
  assert.equal(r.scope, "dealership");
  assert.ok(r.score >= 50, "a story about our own store clears the alert threshold");
});

test("brand-only stories about other stores, sponsorships or incidental crime are dropped", () => {
  // Real headlines that were previously filed as this dealership's news.
  const subaru = [{ keyword: "Subaru", kind: "brand" as const }];
  for (const title of [
    "Agere Automotive Acquires BMW of Tri-Cities in First Dealership Deal",
    "BMW of Cincinnati North Announces Availability of 2027 BMW X7",
    "Scottie Scheffler Announces Personal News Ahead of BMW Championship",
    "Stolen BMW leads to shooting at mom's house",
    "Man Allegedly Posed as Pro Basketball Player to Steal $90,000 BMW From Hotel Valet",
  ]) assert.equal(scoreArticle(title, kw).score, 0, title);
  for (const title of [
    "Boardman Subaru Donates $15K to Glenwood Junior High",
    "TREASURE VALLEY SUBARU IN IDAHO RECEIVES 2026 SUBARU LOVE PROMISE® RETAILER OF THE YEAR AWARD",
    "Subaru of Troy buys property for future expansion",
  ]) assert.equal(scoreArticle(title, subaru).score, 0, title);
});

test("manufacturer news survives the brand-level filters", () => {
  // Recall wording about crashes is not crime; the national arm is not a store; lowercase "of" phrases are not store names.
  assert.ok(scoreArticle("BMW recalls 27,720 cars that could roll away and increase the risk of a crash", kw).score > 0);
  assert.ok(scoreArticle("BMW of North America announces 2027 X5 pricing", kw).score > 0);
  assert.ok(scoreArticle("The best BMW of all time is back in production", kw).score > 0);
  const lr = [{ keyword: "Land Rover", kind: "brand" as const }];
  assert.equal(scoreArticle("LAND ROVER OF Naples Opens New Service Center", lr).score, 0, "multi-word brands match store names in any case");
});

test("official sources rank above search and keep their own posts", async () => {
  const { scoreSourcedArticle, SOURCE_PRIORITY } = await import("@/lib/news/source-rules");
  assert.ok(SOURCE_PRIORITY.dealership < SOURCE_PRIORITY.manufacturer && SOURCE_PRIORITY.manufacturer < SOURCE_PRIORITY.rss && SOURCE_PRIORITY.rss < SOURCE_PRIORITY.search && SOURCE_PRIORITY.search < SOURCE_PRIORITY.crawl);
  // A dealership's own post rarely repeats its name; it is still its news.
  const own = scoreSourcedArticle("dealership", "Join us for Cars & Coffee this Saturday", kw);
  assert.equal(own.scope, "dealership");
  assert.ok(own.score >= 50);
  // Official manufacturer news is kept as brand context even without a keyword match…
  const oem = scoreSourcedArticle("manufacturer", "The all-new X5 arrives at retailers this fall", kw);
  assert.equal(oem.scope, "brand");
  assert.ok(oem.score > 0);
  assert.ok(oem.topics.includes("new_model"));
  // …while the same headline from search, which never names an entity, is not kept.
  assert.equal(scoreSourcedArticle("search", "The all-new X5 arrives at retailers this fall", kw).score, 0);
  assert.equal(scoreSourcedArticle("rss", "Local bakery wins regional award", kw).score, 0);
});
