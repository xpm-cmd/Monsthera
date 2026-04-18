/**
 * Slug conflict detection helpers.
 *
 * Exposes near-miss conflict detection based on Jaccard similarity over
 * hyphen-split tokens. Used by `previewSlug` so agents can spot slugs that
 * sibling articles may have authored inline wikilinks against
 * (e.g. "hrv-and-autonomic-nervous-system" vs
 * "hrv-and-the-autonomic-nervous-system").
 */

/**
 * Jaccard similarity between two sets: |A ∩ B| / |A ∪ B|.
 * Returns 1 when both sets are empty (trivially equal).
 */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) intersection++;
  }
  const union = new Set<string>([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/** Split a slug into non-empty hyphen tokens. */
export function slugTokens(slug: string): Set<string> {
  return new Set(slug.split("-").filter(Boolean));
}

/**
 * Return slugs whose hyphen-token Jaccard similarity with `target` is >= 0.7,
 * excluding the exact match (which callers should report via `alreadyExists`).
 *
 * Returns an empty array when no near-miss is found — callers can proceed
 * with confidence.
 */
export function nearMissConflicts(
  target: string,
  existing: readonly string[],
  threshold = 0.7,
): string[] {
  const targetTokens = slugTokens(target);
  const conflicts: string[] = [];
  for (const candidate of existing) {
    if (candidate === target) continue;
    const score = jaccard(targetTokens, slugTokens(candidate));
    if (score >= threshold) conflicts.push(candidate);
  }
  return conflicts;
}
