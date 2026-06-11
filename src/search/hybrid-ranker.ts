import type { SearchResult } from "./repository.js";
import type { Logger } from "../core/logger.js";
import type { Reranker } from "./reranker.js";
import type { KnowledgeArticleRepository } from "../knowledge/repository.js";
import type { WorkArticleRepository } from "../work/repository.js";
import {
  isLegacyKnowledgeArticle,
  isLegacyQuery,
  isLegacyWorkArticle,
} from "../core/article-trust.js";

// ─── Hybrid ranking stages (E4) ───────────────────────────────────────────
//
// The three post-retrieval ranking stages of `SearchService.search`:
// hybrid merge → optional relevance rerank → trust rerank. Bodies are
// moved verbatim from the original src/search/service.ts; the service
// methods became thin delegators passing explicit deps.

/**
 * Merge BM25 and semantic results using weighted combination.
 *
 * Two scale corrections (C1, 2026-06-10) keep the hybrid path compatible
 * with everything downstream that was calibrated against RAW bm25 scores:
 *
 * 1. Cosine is min-max stretched PER QUERY across the semantic candidate
 *    set. Raw cosines cluster in a narrow band (~0.45-0.65 on this
 *    corpus), so unstretched they contribute a near-constant term that
 *    dilutes bm25 discrimination instead of adding signal.
 * 2. The alpha-mix is rescaled back to bm25 magnitude (× maxBm25).
 *    `scoreContextPackItem` adds static boosts of up to ~+4 that were
 *    implicitly tuned against raw bm25 scores (5-15 for good matches);
 *    feeding it [0,1] hybrid scores let the boosts crush the search
 *    signal 4:1 — measured as NDCG@10 0.098 vs 0.877 (bm25) on the
 *    golden set before this fix.
 *
 * finalScore = (alpha * norm_bm25 + (1 - alpha) * stretched_cosine) * maxBm25
 */
export function mergeResults(
  bm25Results: SearchResult[],
  semanticResults: { id: string; score: number }[],
  alpha: number,
): SearchResult[] {
  // Normalize BM25 scores to [0, 1]
  const maxBm25 = bm25Results.reduce((max, r) => Math.max(max, r.score), 0);
  const normFactor = maxBm25 > 0 ? maxBm25 : 1;

  // Per-query min-max stretch for the cosine term. When every candidate
  // shares the same cosine the semantic signal carries no ordering
  // information — credit semantic hits with 1 so they still edge out
  // docs the semantic search did not surface at all.
  const cosines = semanticResults.map((s) => s.score);
  const minCos = cosines.length > 0 ? Math.min(...cosines) : 0;
  const maxCos = cosines.length > 0 ? Math.max(...cosines) : 0;
  const stretch = (c: number): number =>
    maxCos > minCos ? (c - minCos) / (maxCos - minCos) : 1;

  // Build a map of all candidates
  const candidates = new Map<string, { bm25: SearchResult | null; normBm25: number; cosine: number }>();

  for (const r of bm25Results) {
    candidates.set(r.id, { bm25: r, normBm25: r.score / normFactor, cosine: 0 });
  }

  for (const s of semanticResults) {
    const existing = candidates.get(s.id);
    if (existing) {
      existing.cosine = stretch(s.score);
    } else {
      // Semantic-only candidate — we need BM25 result data for snippet/title
      // Skip if we don't have it (BM25 provides the display data)
      candidates.set(s.id, { bm25: null, normBm25: 0, cosine: stretch(s.score) });
    }
  }

  // Score and sort
  const merged: Array<{ result: SearchResult; hybridScore: number }> = [];
  for (const [, entry] of candidates) {
    if (entry.bm25 === null) continue; // can't display without BM25 data (title, snippet)
    const hybridScore = (alpha * entry.normBm25 + (1 - alpha) * entry.cosine) * normFactor;
    merged.push({
      result: { ...entry.bm25, score: hybridScore },
      hybridScore,
    });
  }

  merged.sort((a, b) => b.hybridScore - a.hybridScore);
  return merged.map((m) => m.result);
}

/** Reranker pool size by profile — how many top hits the LLM re-scores. */
export function rerankTopK(rankProfile: string | undefined): number {
  switch (rankProfile) {
    case "conservative":
      return 10;
    case "tokenmax":
      return 40;
    default:
      return 20;
  }
}

/** Explicit deps for the optional relevance-reranker stage. */
export interface RelevanceRerankDeps {
  readonly rerankEnabled: boolean | undefined;
  readonly reranker: Reranker | undefined;
  readonly rankProfile: string | undefined;
  readonly logger: Logger;
}

/**
 * PR-11 relevance reranker stage — sits between the hybrid merge and the
 * trust rerank. Re-scores the top-K candidates with the configured
 * `Reranker` (a cross-encoder over `container.textGenerator` in production,
 * a no-op stub by default) and reorders them; the tail is left untouched.
 *
 * Fail-open at every step: disabled flag, no reranker, an unhealthy or
 * erroring reranker all return the input order unchanged, so a flaky LLM
 * can never break `search`. In hermetic / semantic-off runs this path is
 * not reached at all, which is why the eval baseline is preserved.
 */
export async function applyReranker(
  query: string,
  results: SearchResult[],
  deps: RelevanceRerankDeps,
): Promise<SearchResult[]> {
  if (!deps.rerankEnabled || deps.reranker === undefined || results.length < 2) {
    return results;
  }

  const topK = Math.min(results.length, rerankTopK(deps.rankProfile));
  const head = results.slice(0, topK);
  const tail = results.slice(topK);

  const health = await deps.reranker.healthCheck();
  if (!health.ok) {
    deps.logger.warn("Reranker unhealthy; keeping hybrid order", {
      operation: "rerank",
      reranker: deps.reranker.name,
    });
    return results;
  }

  const candidates = head.map((r) => ({ id: r.id, text: `${r.title}\n${r.snippet}` }));
  const scored = await deps.reranker.rerank(query, candidates);
  if (!scored.ok) {
    deps.logger.warn("Reranker failed; keeping hybrid order", {
      operation: "rerank",
      reranker: deps.reranker.name,
      error: scored.error.message,
    });
    return results;
  }

  const scoreById = new Map(scored.value.map((s) => [s.id, s.score]));
  // Reweight each hit's hybrid score by its [0,1] relevance, then re-sort.
  // A neutral 1.0 (the stub, or an id the reranker omitted) leaves the score
  // untouched, so the downstream trust rerank sees exactly today's scores —
  // making a stub or disabled reranker an exact no-op.
  const reweighted = head.map((r) => ({ ...r, score: r.score * (scoreById.get(r.id) ?? 1) }));
  reweighted.sort((a, b) => b.score - a.score);
  return [...reweighted, ...tail];
}

/** Explicit deps for the trust rerank stage (article lookups). */
export interface TrustRerankDeps {
  readonly knowledgeRepo: KnowledgeArticleRepository;
  readonly workRepo: WorkArticleRepository;
}

export async function rerankForTrust(
  query: string,
  results: SearchResult[],
  deps: TrustRerankDeps,
): Promise<SearchResult[]> {
  if (results.length === 0 || isLegacyQuery(query)) {
    return results;
  }

  const reranked = await Promise.all(results.map(async (result) => {
    const trustScore = await computeTrustAdjustedScore(result, deps);
    return {
      result,
      trustScore,
    };
  }));

  reranked.sort((left, right) => right.trustScore - left.trustScore);
  const finalResults = reranked.map(({ result, trustScore }) => ({
    ...result,
    score: Number(Math.max(trustScore, 0).toFixed(3)),
  }));
  const hasPositiveScore = finalResults.some((result) => result.score > 0);
  return hasPositiveScore
    ? finalResults.filter((result) => result.score > 0)
    : finalResults;
}

async function computeTrustAdjustedScore(
  result: SearchResult,
  deps: TrustRerankDeps,
): Promise<number> {
  let score = result.score;
  if (result.type === "knowledge") {
    const article = await deps.knowledgeRepo.findById(result.id);
    if (!article.ok) return score;

    if (isLegacyKnowledgeArticle(article.value)) score -= 1.2;
    if (article.value.sourcePath) score += 0.45;
    const category = article.value.category.toLowerCase();
    if (["architecture", "decision", "guide", "runbook"].includes(category)) score += 0.15;
    return score;
  }

  const article = await deps.workRepo.findById(result.id);
  if (!article.ok) return score;

  if (isLegacyWorkArticle(article.value)) score -= 1.1;
  if (article.value.phase === "planning" || article.value.phase === "implementation" || article.value.phase === "review") {
    score += 0.2;
  }
  return score;
}
