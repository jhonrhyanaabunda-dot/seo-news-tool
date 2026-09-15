import { test } from "node:test";
import assert from "node:assert/strict";
import { planFetch } from "@/lib/seo/render-policy";

test("no browser is used unless rendering is switched on", () => {
  assert.equal(planFetch("auto", "off"), "http-only");
  // Even a dealership set to "always" cannot render where no browser exists (Vercel).
  assert.equal(planFetch("always", "off"), "http-only");
});

test("a dealership opt-out overrides the global setting", () => {
  assert.equal(planFetch("never", "fallback"), "http-only");
  assert.equal(planFetch("never", "always"), "http-only");
});

test("fallback escalates only for page fetches, never for link checks", () => {
  assert.equal(planFetch("auto", "fallback"), "escalate-if-blocked");
  assert.equal(planFetch("auto", "fallback", { headersOnly: true }), "http-only");
  assert.equal(planFetch("always", "always", { headersOnly: true }), "http-only");
});

test("JavaScript-only sites are rendered without a wasted plain request", () => {
  assert.equal(planFetch("always", "fallback"), "browser-first");
  assert.equal(planFetch("auto", "always"), "browser-first");
  assert.equal(planFetch("always", "always"), "browser-first");
});
