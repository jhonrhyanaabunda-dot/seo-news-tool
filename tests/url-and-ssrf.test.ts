import { test } from "node:test";
import assert from "node:assert/strict";
import { assertUrlShape, isPrivateIp, UnsafeUrlError } from "@/lib/security/ssrf";
import { classifyPath, normalizeUrl, urlsEquivalent } from "@/lib/seo/url";

test("private and metadata addresses are rejected", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]) assert.equal(isPrivateIp(ip), false, ip);
});

test("unsafe URL shapes throw", () => {
  for (const u of ["file:///etc/passwd", "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://example.com:8080/", "http://user:pw@example.com/", "http://intranet/", "http://printer.local/", "http://169.254.169.254/latest/meta-data"]) {
    assert.throws(() => assertUrlShape(u), UnsafeUrlError, u);
  }
  assert.doesNotThrow(() => assertUrlShape("https://www.bmw.com/"));
});

test("normalizeUrl strips tracking params, fragments and trailing slashes", () => {
  assert.equal(normalizeUrl("https://WWW.Example.com/Service/?utm_source=x&b=2&a=1#top"), "https://www.example.com/Service?a=1&b=2");
  assert.ok(urlsEquivalent("http://example.com/a/", "https://www.example.com/a"));
});

test("dealership page classification", () => {
  const c = (p: string) => classifyPath(new URL(`https://d.com${p}`));
  assert.equal(c("/"), "home");
  assert.equal(c("/new-vehicles/"), "new_inventory");
  assert.equal(c("/used-inventory/index.htm"), "used_inventory");
  assert.equal(c("/service/schedule-service.htm"), "service");
  assert.equal(c("/finance/apply-for-financing"), "finance");
  assert.equal(c("/specials/new.htm"), "specials");
  assert.equal(c("/contact-us"), "contact");
  assert.equal(c("/new/BMW/2026-BMW-X5-5UX23EU01T9A12345.htm"), "vehicle_detail");
});

test("crawl requests keep the site's own URL form; only the de-duplication key is normalised", async () => {
  const { normalizeUrl, requestUrl } = await import("@/lib/seo/url");
  const u = "https://www.bmwfwb.com/new-vehicles/?utm_source=x&year=2027#top";
  assert.equal(requestUrl(u), "https://www.bmwfwb.com/new-vehicles/?year=2027", "trailing slash kept, tracking and fragment dropped");
  assert.equal(normalizeUrl(u), "https://www.bmwfwb.com/new-vehicles?year=2027");
  assert.equal(normalizeUrl(requestUrl(u)), normalizeUrl(u), "both forms share one de-duplication key");
});
