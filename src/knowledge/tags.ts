/**
 * Tag normalization — the single definition of "the same tag" shared by the
 * write path (Zod transform in schemas.ts) and the audit path (the
 * tag_near_duplicate lint rule). Keeping one implementation means detection
 * and prevention can never disagree about what counts as a duplicate.
 */

/**
 * Clean a single tag:
 *  - trim surrounding whitespace
 *  - strip a single matching pair of surrounding quotes ('...' or "...")
 *  - collapse internal whitespace runs to one space
 *
 * Returns "" when nothing survives (caller drops empties).
 */
export function normalizeTag(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      s = s.slice(1, -1).trim();
    }
  }
  return s.replace(/\s+/g, " ");
}

/**
 * Normalize a tag list so a dirty tag cannot reach disk: clean each tag, drop
 * empties, and dedupe by a case-folded key while preserving the first-seen
 * tag's original casing. Order-preserving (first occurrence wins).
 */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const cleaned = normalizeTag(raw);
    if (cleaned === "") continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}
