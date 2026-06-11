import { normalizeTag } from "../../knowledge/tags.js";
import type { TagNearDuplicateFinding } from "../lint.js";

// ─── Tag-hygiene check ────────────────────────────────────────────────────
// Body is moved verbatim from the original src/work/lint.ts.

/**
 * Flag tag lists whose entries collapse to the same normalized key. One
 * finding per duplicated key, listing the raw variants. Reuses normalizeTag
 * (the write-path normalizer) so detection and prevention agree on identity.
 * Skips articles with fewer than two tags — nothing can duplicate.
 */
export function scanTagNearDuplicates(
  frontmatter: Record<string, unknown>,
  file: string,
): readonly TagNearDuplicateFinding[] {
  const raw = frontmatter["tags"];
  const tags = Array.isArray(raw) ? raw.filter((t): t is string => typeof t === "string") : [];
  if (tags.length < 2) return [];

  const groups = new Map<string, string[]>();
  for (const tag of tags) {
    const cleaned = normalizeTag(tag);
    if (cleaned === "") continue;
    const key = cleaned.toLowerCase();
    const variants = groups.get(key);
    if (variants) variants.push(tag);
    else groups.set(key, [tag]);
  }

  const findings: TagNearDuplicateFinding[] = [];
  for (const [key, variants] of groups) {
    if (variants.length >= 2) {
      findings.push({
        file,
        severity: "warning",
        rule: "tag_near_duplicate",
        normalized: key,
        variants: [...variants],
      });
    }
  }
  return findings;
}
