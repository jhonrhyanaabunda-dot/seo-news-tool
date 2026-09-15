import type { RemoteAuditResult } from "@/lib/db/schema";
import { CHECKS, CHECKS_BY_KEY } from "./config";
import { fingerprint, type CheckResult, type EvalResult, type IssueDraft } from "./evaluate";

/**
 * Turn a limited remote (Google) homepage check into the same issues/checks
 * structure as a full crawl. Only checks Google could actually verify are
 * applicable; everything else is "not checked". Pure and deterministic.
 */
export function evaluateRemoteAudit(a: RemoteAuditResult): EvalResult {
  const not = (v: boolean | null) => (v === null ? null : !v);
  const findings: Record<string, { affected: boolean | null; message: string }> = {
    not_https: { affected: !a.https, message: "The homepage is not served over HTTPS." },
    title_missing: { affected: not(a.titleOk), message: "Google's check found no page title on the homepage." },
    description_missing: { affected: not(a.descriptionOk), message: "Google's check found no meta description on the homepage." },
    noindex_important: { affected: not(a.crawlable), message: "Google's check found the homepage is blocked from indexing (noindex or robots rules)." },
    canonical_missing: { affected: a.canonical === null ? null : a.canonical === "missing", message: "The homepage has no canonical tag." },
    canonical_mismatch: { affected: a.canonical === null || a.canonical === "missing" ? null : a.canonical === "invalid", message: "Google reports the homepage's canonical tag is invalid or points to another page." },
    image_alt_missing: { affected: a.imagesMissingAlt === null ? null : a.imagesMissingAlt > 0, message: `${a.imagesMissingAlt ?? 0} image(s) on the homepage have no alt text.` },
    viewport_missing: { affected: not(a.viewportOk), message: "Google's check found no mobile viewport tag on the homepage." },
  };
  const checks: CheckResult[] = CHECKS.map((c) => {
    const f = findings[c.key];
    const known = Boolean(f) && f.affected !== null;
    return { checkKey: c.key, category: c.category, label: c.label, severity: c.severity, scope: c.scope, applicable: known ? 1 : 0, affected: known && f.affected ? 1 : 0 };
  });
  const issues: IssueDraft[] = Object.entries(findings)
    .filter(([, f]) => f.affected === true)
    .map(([key, f]) => {
      const def = CHECKS_BY_KEY[key];
      return {
        checkKey: key,
        category: def.category,
        severity: def.severity,
        url: a.finalUrl,
        pageId: null,
        message: f.message,
        recommendation: def.recommendation,
        details: { source: "Google PageSpeed Insights (limited homepage check)" },
        fingerprint: fingerprint(key, a.finalUrl),
      };
    })
    .sort((x, y) => (x.fingerprint < y.fingerprint ? -1 : 1));
  return { issues, checks };
}
