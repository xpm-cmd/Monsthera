import { getCanonicalValueViolations } from "../guards.js";
import type { CanonicalValueMismatchFinding } from "../lint.js";
import type { CanonicalValue } from "../policy-loader.js";

// ─── Canonical-value check ────────────────────────────────────────────────
// Extracted from the per-article block inside `scanCorpus` in the original
// src/work/lint.ts; the violation loop and finding construction are verbatim.

/**
 * Run the canonical-value registry against one article body and emit one
 * `canonical_value_mismatch` finding per violation. Wraps
 * `getCanonicalValueViolations` (shared with the phase guards) and attaches
 * the registry entry's `validSinceCommit` when declared.
 */
export function scanCanonicalValues(
  body: string,
  file: string,
  canonicalValues: readonly CanonicalValue[],
): readonly CanonicalValueMismatchFinding[] {
  const findings: CanonicalValueMismatchFinding[] = [];

  const violations = getCanonicalValueViolations(
    { content: body },
    canonicalValues,
  );

  for (const v of violations) {
    const source = findCanonicalValue(canonicalValues, v.name);
    findings.push({
      file,
      severity: "error",
      rule: "canonical_value_mismatch",
      name: v.name,
      expected: v.expected,
      found: v.found,
      lineHint: v.lineHint,
      ...(source?.validSinceCommit ? { sinceCommit: source.validSinceCommit } : {}),
    });
  }

  return findings;
}

function findCanonicalValue(
  values: readonly CanonicalValue[],
  name: string,
): CanonicalValue | undefined {
  return values.find((v) => v.name === name);
}
