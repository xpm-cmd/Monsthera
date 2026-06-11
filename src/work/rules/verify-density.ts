import type { VerifyDensityFinding } from "../lint.js";
import { extractLineForIndex } from "./shared.js";

// ─── Verify-density check ─────────────────────────────────────────────────
// Bodies are moved verbatim from the original src/work/lint.ts.

/** Default threshold when no policy or CLI flag overrides. */
export const DEFAULT_VERIFY_DENSITY_THRESHOLD = 0.2;

/** Strip code regions before counting so example markers in fences do not dilute/inflate density. */
function stripCodeRegionsLocal(content: string): string {
  let result = content;
  result = result.replace(/<!--[\s\S]*?-->/g, "");
  result = result.replace(/^([ \t]{0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n\1\2[ \t]*$/gm, "");
  result = result.replace(/(`{1,3})(?:(?!\1)[^\n])+?\1/g, "");
  return result;
}

/**
 * Count `(citations, verify-markers)` in body text, then emit a warning
 * if the ratio exceeds `threshold` and the article actually carries
 * any citations. Zero citations → zero density, no finding (an article
 * with only prose may legitimately carry `[verify]` markers about
 * things other than cited claims — that's not density signal).
 *
 * Marker grammar accepted:
 *   [verify]
 *   [verify at <anything-except-right-bracket>]
 *   [verify-deferred-to-<anything-except-right-bracket>]
 *
 * Citations counted are `k-*` / `w-*` inline ids and `[[slug]]`
 * wikilinks. Duplicates are NOT deduped — the ratio is measured in
 * raw occurrences, matching how a reader actually encounters them.
 */
export function scanVerifyDensity(
  body: string,
  file: string,
  threshold: number,
): VerifyDensityFinding | undefined {
  const stripped = stripCodeRegionsLocal(body);

  const inlineIds = [...stripped.matchAll(/\b[kw]-[a-z0-9]+(?:-[a-z0-9]+)*\b/g)];
  const wikilinks = [...stripped.matchAll(/\[\[([^\]]+)\]\]/g)];
  const citationCount = inlineIds.length + wikilinks.length;

  const verifyMatches = [
    ...stripped.matchAll(/\[verify(?:\s+at\s+[^\]]+|-deferred-to-[^\]]+)?\]/g),
  ];
  const verifyCount = verifyMatches.length;

  if (citationCount === 0 || verifyCount === 0) return undefined;

  const density = verifyCount / citationCount;
  if (density <= threshold) return undefined;

  const first = verifyMatches[0];
  const oldestLine =
    first !== undefined ? extractLineForIndex(stripped, first.index ?? 0) : undefined;

  return {
    file,
    severity: "warning",
    rule: "verify_density_exceeded",
    citationCount,
    verifyCount,
    densityPercent: Math.round(density * 1000) / 10, // one decimal
    threshold,
    ...(oldestLine ? { oldestMarker: { line: oldestLine } } : {}),
  };
}
