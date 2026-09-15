import { CATEGORIES, CHECKS_BY_KEY, DEDUCTION_TIERS, type Category, type Severity } from "./checks/config";
import type { CheckResult } from "./checks/evaluate";

export interface ScoredCheck extends CheckResult {
  status: "pass" | "warn" | "fail" | "na";
  maxPoints: number;
  pointsDeducted: number;
}

export interface ScoreResult {
  score: number;
  categories: Record<Category, { score: number; max: number; label: string; applicable: boolean }>;
  checks: ScoredCheck[];
  passed: number;
  failed: number;
  warned: number;
}

function tierFraction(severity: Severity, ratio: number): number {
  for (const tier of DEDUCTION_TIERS[severity]) if (ratio >= tier.minRatio) return tier.fraction;
  return 0;
}

/**
 * Deterministic score from check results. See checks/config.ts for the model.
 * Integer maths is avoided until the final rounding so small changes in rules
 * behave predictably.
 */
export function computeScore(results: CheckResult[]): ScoreResult {
  const catTotals = new Map<Category, { max: number; deducted: number }>();
  const checks: ScoredCheck[] = results.map((r) => {
    const def = CHECKS_BY_KEY[r.checkKey];
    if (r.applicable === 0) return { ...r, status: "na", maxPoints: 0, pointsDeducted: 0 };
    let fraction = 0;
    if (r.affected > 0) {
      if (def.scope === "site") fraction = r.siteRatio !== undefined ? Math.min(1, r.siteRatio) : 1;
      else fraction = tierFraction(def.severity, r.affected / r.applicable);
    }
    const deducted = def.points * fraction;
    const t = catTotals.get(def.category) ?? { max: 0, deducted: 0 };
    t.max += def.points;
    t.deducted += deducted;
    catTotals.set(def.category, t);
    const status = r.affected === 0 ? "pass" : def.severity === "critical" ? "fail" : "warn";
    return { ...r, status, maxPoints: def.points, pointsDeducted: Math.round(deducted * 100) / 100 };
  });

  let weighted = 0;
  let weights = 0;
  const categories = {} as ScoreResult["categories"];
  for (const [key, meta] of Object.entries(CATEGORIES) as Array<[Category, { label: string; weight: number }]>) {
    const t = catTotals.get(key);
    if (!t || t.max === 0) {
      categories[key] = { score: 100, max: 100, label: meta.label, applicable: false };
      continue;
    }
    const catScore = 100 * (1 - t.deducted / t.max);
    categories[key] = { score: Math.round(catScore), max: 100, label: meta.label, applicable: true };
    weighted += catScore * meta.weight;
    weights += meta.weight;
  }
  const score = weights === 0 ? 0 : Math.round(weighted / weights);
  return {
    score: Math.max(0, Math.min(100, score)),
    categories,
    checks,
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    warned: checks.filter((c) => c.status === "warn").length,
  };
}

export function scoreBand(score: number | null | undefined): "good" | "fair" | "poor" | "unknown" {
  if (score === null || score === undefined) return "unknown";
  if (score >= 85) return "good";
  if (score >= 65) return "fair";
  return "poor";
}
