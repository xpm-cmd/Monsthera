/**
 * Retrieval-quality metrics for the eval harness (C1).
 *
 * Binary relevance: an item is relevant iff its id is in the `relevant` set.
 * All functions are pure and total. `k` is clamped to `[0, ranked.length]`
 * via slice, so callers never need to pre-clamp.
 */

/** Fraction of the top-k results that are relevant. */
export function precisionAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const top = ranked.slice(0, Math.max(0, k));
  if (top.length === 0) return 0;
  let hits = 0;
  for (const id of top) if (relevant.has(id)) hits++;
  return hits / top.length;
}

/** Fraction of the relevant items that appear in the top-k. */
export function recallAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  if (relevant.size === 0) return 0;
  const top = ranked.slice(0, Math.max(0, k));
  let hits = 0;
  for (const id of top) if (relevant.has(id)) hits++;
  return hits / relevant.size;
}

/**
 * Normalized Discounted Cumulative Gain at k, with binary gains.
 * DCG = Σ rel_i / log2(i + 2); IDCG is the DCG of the perfect ordering
 * (all relevant items first). Returns DCG / IDCG, or 0 when IDCG is 0.
 */
export function ndcgAtK(ranked: readonly string[], relevant: ReadonlySet<string>, k: number): number {
  const top = ranked.slice(0, Math.max(0, k));
  let dcg = 0;
  for (let i = 0; i < top.length; i++) {
    const id = top[i];
    if (id !== undefined && relevant.has(id)) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(relevant.size, top.length);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

/** Reciprocal of the rank of the first relevant item (1-indexed); 0 if none. */
export function reciprocalRank(ranked: readonly string[], relevant: ReadonlySet<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    const id = ranked[i];
    if (id !== undefined && relevant.has(id)) return 1 / (i + 1);
  }
  return 0;
}

/** Arithmetic mean; 0 for an empty list. */
export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Round to `digits` decimal places (default 4) for stable report output. */
export function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
