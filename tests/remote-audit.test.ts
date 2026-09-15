import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateRemoteAudit } from "@/lib/seo/checks/remote-evaluate";
import { computeScore } from "@/lib/seo/scoring";
import type { RemoteAuditResult } from "@/lib/db/schema";

const base: RemoteAuditResult = {
  provider: "pagespeed", url: "https://www.dealer.com/", finalUrl: "https://www.dealer.com/", error: null,
  statusOk: true, titleOk: true, descriptionOk: false, crawlable: true, canonical: "missing", imagesMissingAlt: 3, viewportOk: true, https: true, seoScore: 83, performance: null,
};

test("a limited Google check reports only what Google verified", () => {
  const r = evaluateRemoteAudit(base);
  assert.deepEqual(r.issues.map((i) => i.checkKey).sort(), ["canonical_missing", "description_missing", "image_alt_missing"]);
  // Checks Google cannot verify (broken links, duplicates, sitemap…) are not applicable, not "passed".
  const links = r.checks.find((c) => c.checkKey === "broken_internal_link")!;
  assert.equal(links.applicable, 0);
  assert.equal(r.checks.find((c) => c.checkKey === "title_missing")!.applicable, 1);
});

test("unknown audit values are not reported as problems and the result is deterministic", () => {
  const r = evaluateRemoteAudit({ ...base, descriptionOk: null, canonical: null, imagesMissingAlt: null });
  assert.equal(r.issues.length, 0);
  assert.deepEqual(evaluateRemoteAudit(base), evaluateRemoteAudit(structuredClone(base)));
  assert.equal(computeScore(evaluateRemoteAudit(base).checks).score, computeScore(evaluateRemoteAudit(base).checks).score);
});
