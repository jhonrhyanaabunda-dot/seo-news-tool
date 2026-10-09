import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_NEXT, safeNextPath } from "@/lib/auth/safe-next";

/**
 * `?next=` on the login page is attacker-controllable: anyone can send a link to
 * our own sign-in form carrying someone else's destination. Everything that is
 * not positively recognised as a path inside this app must collapse to "/".
 */

test("legitimate internal paths are preserved", () => {
  for (const path of ["/", "/dashboard", "/seo-news", "/reports", "/settings", "/dealerships/1", "/dealerships/12?tab=issues", "/news?status=all&p=2", "/account#password"]) {
    assert.equal(safeNextPath(path), path, `${path} should survive untouched`);
  }
});

test("protocol-relative destinations are rejected", () => {
  assert.equal(safeNextPath("//evil.example"), DEFAULT_NEXT);
  assert.equal(safeNextPath("//evil.example/path"), DEFAULT_NEXT);
  assert.equal(safeNextPath("///evil.example"), DEFAULT_NEXT);
});

test("backslash destinations are rejected", () => {
  // The original filter allowed these: they start with "/" and not "//", but a
  // browser normalises `Location: /\host` to the protocol-relative `//host`.
  for (const v of ["/\\evil.example", "/\\\\evil.example", "\\\\evil.example", "/path\\..\\evil", "/\\/evil.example"]) {
    assert.equal(safeNextPath(v), DEFAULT_NEXT, `${v} must not be allowed`);
  }
});

test("absolute URLs are rejected", () => {
  for (const v of ["https://evil.example", "http://evil.example", "HTTPS://evil.example", "ftp://evil.example", "https://evil.example/dealerships/1"]) {
    assert.equal(safeNextPath(v), DEFAULT_NEXT, `${v} must not be allowed`);
  }
});

test("script and data schemes are rejected", () => {
  for (const v of ["javascript:alert(1)", "JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)"]) {
    assert.equal(safeNextPath(v), DEFAULT_NEXT, `${v} must not be allowed`);
  }
});

test("encoded variants cannot smuggle a bypass", () => {
  for (const v of [
    "%2F%2Fevil.example", // //evil.example
    "/%5Cevil.example", // /\evil.example
    "%2F%5Cevil.example",
    "/%2F%2Fevil.example",
    "%68%74%74%70%73%3A%2F%2Fevil.example", // https://evil.example
    "/%09/evil.example", // embedded tab
  ]) {
    assert.equal(safeNextPath(v), DEFAULT_NEXT, `${v} must not be allowed`);
  }
});

test("whitespace and control characters are rejected", () => {
  for (const v of ["/\tevil", "/\nevil", "/ evil", "/evil\u0000", "\u0000/evil"]) {
    assert.equal(safeNextPath(v), DEFAULT_NEXT, `${JSON.stringify(v)} must not be allowed`);
  }
});

test("missing, empty and malformed values fall back to the dashboard", () => {
  assert.equal(safeNextPath(undefined), DEFAULT_NEXT);
  assert.equal(safeNextPath(null), DEFAULT_NEXT);
  assert.equal(safeNextPath(""), DEFAULT_NEXT);
  assert.equal(safeNextPath("%"), DEFAULT_NEXT, "an undecodable value is malformed, not a path");
  assert.equal(safeNextPath("not-a-path"), DEFAULT_NEXT, "a bare word could resolve relative to anything");
});

test("the result is always an in-app path", () => {
  // Whatever goes in, what comes out must be safe to hand to redirect().
  const inputs = ["/ok", "//evil", "/\\evil", "https://evil", "javascript:x", "", "%2F%2Fevil", "/a?b=1#c", "not-a-path", "\\evil"];
  for (const v of inputs) {
    const out = safeNextPath(v);
    assert.ok(out.startsWith("/"), `${v} -> ${out} must start with /`);
    assert.ok(!out.startsWith("//"), `${v} -> ${out} must not be protocol-relative`);
    assert.ok(!out.includes("\\"), `${v} -> ${out} must not contain a backslash`);
    assert.ok(!/^[a-z]+:/i.test(out), `${v} -> ${out} must not carry a scheme`);
  }
});
