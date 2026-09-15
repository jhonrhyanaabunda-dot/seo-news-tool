import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePage } from "@/lib/seo/parser";

const base = "https://www.example-dealer.com/";

test("extracts core SEO fields", () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>New BMW Inventory | Example BMW</title>
    <meta name="description" content="Shop new BMW models at Example BMW.">
    <meta name="viewport" content="width=device-width">
    <link rel="canonical" href="/new-inventory">
    <meta property="og:title" content="t"><meta property="og:image" content="i">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"AutoDealer"},{"@type":"WebPage"}]}</script>
    <script type="application/ld+json">{ broken json </script>
    <script src="/a.js"></script><script src="/b.js" defer></script>
  </head><body>
    <h1>New inventory</h1><h2>SUVs</h2>
    <img src="/car.jpg"><img src="/logo.png" alt="Logo" width="10" height="10"><img src="/deco.png" role="presentation">
    <a href="/service">Service</a><a href="https://maps.google.com/x">Map</a><a href="tel:123">Call</a><a href="#top">Top</a>
    <img src="http://insecure.example.com/x.jpg" alt="x">
  </body></html>`;
  const d = parsePage(html, base);
  assert.equal(d.title, "New BMW Inventory | Example BMW");
  assert.equal(d.canonical, "https://www.example-dealer.com/new-inventory");
  assert.deepEqual(d.h1, ["New inventory"]);
  assert.ok(d.schemaTypes.includes("AutoDealer"));
  assert.equal(d.schemaErrors, 1);
  assert.equal(d.imagesCount, 3);
  assert.equal(d.imagesMissingAlt, 1);
  assert.equal(d.blockingScriptsCount, 1);
  assert.equal(d.mixedContentCount, 1);
  assert.equal(d.internalLinksCount, 1);
  assert.equal(d.externalLinksCount, 1);
  assert.equal(d.lang, "en");
  assert.equal(d.clientRedirect, null);
});

test("detects JavaScript and meta-refresh redirects", () => {
  const js = parsePage(`<!DOCTYPE html><html><head><script>window.onload=function(){window.location.href="/lander"}</script></head></html>`, base);
  assert.deepEqual(js.clientRedirect, { type: "script", target: "https://www.example-dealer.com/lander" });
  const meta = parsePage(`<html><head><meta http-equiv="refresh" content="0; url=https://other.example.com/"></head><body></body></html>`, base);
  assert.deepEqual(meta.clientRedirect, { type: "meta", target: "https://other.example.com/" });
});

test("tracking pixels are not counted as content images", () => {
  // Beacons observed on live dealer sites; each was flagged as "missing alt text" on every page.
  const html = `<html><body>
    <img src="https://arttrk.com/pixel/?ad_log=referer&action=content&pixid=804ec3ef">
    <img src="https://bidagent.xad.com/conv/286243?ts={TIMESTAMP}">
    <img src="https://www.facebook.com/tr/?id=440021196338763&ev=PageView">
    <img src="https://bcp.crwdcntrl.net/5/c=931/b=93898168">
    <img src="/spacer.gif" width="1" height="1">
    <img src="/beacon.gif" style="display:none">
    <img src="/hidden.gif" hidden>
    <img src="/cars/x5.jpg">
    <img src="/cars/x3.jpg" alt="2026 BMW X3" width="800" height="600">
  </body></html>`;
  const d = parsePage(html, base);
  assert.equal(d.imagesCount, 2);
  assert.equal(d.imagesMissingAlt, 1);
  assert.deepEqual(d.imagesMissingAltSamples, ["/cars/x5.jpg"]);
  assert.equal(d.imagesWithoutDimensions, 1);
});
