import { test } from "node:test";
import assert from "node:assert/strict";
import { detectBlock } from "@/lib/seo/block-detect";

test("detects Akamai access denied pages", () => {
  const v = detectBlock({ status: 403, headers: { server: "AkamaiGHost" }, body: "<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY>Reference&#32;&#35;18&#46;abc</BODY></HTML>" });
  assert.equal(v.blocked, true);
  assert.equal(v.vendor, "Akamai");
});

test("detects Cloudflare challenge even with HTTP 200", () => {
  const v = detectBlock({ status: 200, headers: {}, body: "<html><head><title>Just a moment...</title></head><body><script>window._cf_chl_opt={}</script></body></html>" });
  assert.equal(v.blocked, true);
  assert.equal(v.vendor, "Cloudflare");
});

test("403 without markers is still a refusal; normal pages are not blocked", () => {
  assert.equal(detectBlock({ status: 403, headers: {}, body: "<title>Dealer Website</title>" }).blocked, true);
  assert.equal(detectBlock({ status: 200, headers: {}, body: "<title>Price Ford</title><p>Welcome to our access road location</p>" }).blocked, false);
  assert.equal(detectBlock({ status: 404, headers: {}, body: "<title>Not found</title>" }).blocked, false);
});

test("the Cloudflare challenge served by the parked BMW domain is detected", () => {
  const v = detectBlock({ status: 403, headers: { server: "cloudflare", "cf-ray": "x" }, body: "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body></body></html>" });
  assert.equal(v.blocked, true);
  assert.equal(v.vendor, "Cloudflare");
});

test("the real Dealer Inspire challenge page is detected even when served with HTTP 200", async () => {
  const { readFileSync } = await import("node:fs");
  const body = readFileSync(new URL("./fixtures/dealer-inspire-block.html", import.meta.url), "utf8");
  const v = detectBlock({ status: 200, headers: {}, body });
  assert.equal(v.blocked, true);
  assert.match(v.vendor ?? "", /Cloudflare/);
});
