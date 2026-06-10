import type { CustomFrontmatterFinding } from "../lint.js";
import type { CustomFrontmatterRule } from "../policy-loader.js";

// ─── Custom-frontmatter check ─────────────────────────────────────────────
// Body is moved verbatim from the original src/work/lint.ts.

/**
 * Validate one article's custom frontmatter against the rules that target its
 * category (PR-14b, ADR-020 P3). Values arrive pre-coerced from the markdown
 * parser (numbers/booleans/strings), so the type check is a direct `typeof`.
 * An absent-but-not-required field is fine; a missing required field, a
 * wrong-typed value, or an out-of-range number each emit one finding at the
 * rule's severity.
 */
export function scanCustomFrontmatter(
  frontmatter: Record<string, unknown>,
  rules: readonly CustomFrontmatterRule[],
  file: string,
): readonly CustomFrontmatterFinding[] {
  const category = typeof frontmatter["category"] === "string" ? frontmatter["category"] : "";
  const findings: CustomFrontmatterFinding[] = [];

  for (const rule of rules) {
    if (rule.category !== category) continue;
    const make = (
      problem: CustomFrontmatterFinding["problem"],
      detail: string,
    ): CustomFrontmatterFinding => ({
      file,
      severity: rule.severity,
      rule: "custom_frontmatter_violation",
      articleCategory: category,
      key: rule.key,
      problem,
      detail,
    });

    const value = frontmatter[rule.key];
    if (value === undefined || value === null) {
      if (rule.required) findings.push(make("missing_required", `required custom field "${rule.key}" is missing`));
      continue;
    }

    if (rule.type !== undefined && typeof value !== rule.type) {
      findings.push(make("wrong_type", `expected ${rule.type}, got ${typeof value}`));
      continue;
    }

    if (rule.min !== undefined || rule.max !== undefined) {
      const num = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(num)) {
        findings.push(make("wrong_type", `expected a number for range check, got "${String(value)}"`));
      } else if ((rule.min !== undefined && num < rule.min) || (rule.max !== undefined && num > rule.max)) {
        findings.push(make("out_of_range", `value ${num} outside [${rule.min ?? "-inf"}, ${rule.max ?? "inf"}]`));
      }
    }
  }

  return findings;
}
