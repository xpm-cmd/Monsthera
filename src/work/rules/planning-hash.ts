import type { PlanningSectionTamperedFinding } from "../lint.js";
import { computePlanningHash } from "../planning-hash.js";

// ─── Planning-hash check ──────────────────────────────────────────────────
// Body is moved verbatim from the original src/work/lint.ts.

/**
 * Compare a work article's stored `planning_hash` against the current
 * content of its `## Planning` section. Skip when the article is still
 * in planning (no hash to pin yet), when the hash is absent (historical
 * article authored before the rule existed), or when the article lacks a
 * planning section entirely. Otherwise emit an error finding on mismatch.
 */
export function scanPlanningHash(
  frontmatter: Record<string, unknown>,
  body: string,
  file: string,
): PlanningSectionTamperedFinding | undefined {
  const expected = frontmatter["planning_hash"];
  if (typeof expected !== "string" || expected.length === 0) return undefined;

  const phase = typeof frontmatter["phase"] === "string" ? frontmatter["phase"] : "";
  if (phase === "planning") return undefined;

  const id = typeof frontmatter["id"] === "string" ? frontmatter["id"] : "";
  const actual = computePlanningHash(body);
  if (actual === expected) return undefined;

  return {
    file,
    severity: "error",
    rule: "planning_section_tampered",
    articleId: id,
    phase,
    expectedHash: expected,
    actualHash: actual,
  };
}
