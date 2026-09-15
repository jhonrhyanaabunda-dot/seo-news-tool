/**
 * Change detection between two scans, based on stable issue fingerprints.
 * Pure functions — used by scan finalisation (scan vs previous scan) and by
 * digests (latest scan vs the scan before the reporting period).
 *
 * Fingerprint list entries are "<severity char><fingerprint>", e.g. "c3fa9…".
 */

export type SeverityChar = "c" | "w" | "i";

export function severityChar(severity: string): SeverityChar {
  return severity === "critical" ? "c" : severity === "warning" ? "w" : "i";
}

export function encodeFingerprint(severity: string, fingerprint: string): string {
  return `${severityChar(severity)}${fingerprint}`;
}

export interface FingerprintDiff {
  added: string[];
  resolved: string[];
  addedBySeverity: Record<SeverityChar, number>;
  resolvedBySeverity: Record<SeverityChar, number>;
}

export function diffFingerprints(previous: string[] | null | undefined, current: string[]): FingerprintDiff {
  const prevSet = new Set((previous ?? []).map((f) => f.slice(1)));
  const currSet = new Set(current.map((f) => f.slice(1)));
  const added = current.filter((f) => !prevSet.has(f.slice(1)));
  const resolved = (previous ?? []).filter((f) => !currSet.has(f.slice(1)));
  const count = (list: string[]) => {
    const out: Record<SeverityChar, number> = { c: 0, w: 0, i: 0 };
    for (const f of list) out[f[0] as SeverityChar] = (out[f[0] as SeverityChar] ?? 0) + 1;
    return out;
  };
  return { added, resolved, addedBySeverity: count(added), resolvedBySeverity: count(resolved) };
}

export function isSignificantScoreChange(delta: number | null, threshold: number): boolean {
  return delta !== null && Math.abs(delta) >= threshold;
}
