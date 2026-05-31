import type { Result } from "../core/result.js";
import type { MonstheraError } from "../core/errors.js";
import type { ContextPack } from "../search/service.js";
import type { SearchResult } from "../search/repository.js";
import type { GoldenCase } from "./golden.js";
import { precisionAtK, recallAtK, ndcgAtK, reciprocalRank, mean, round } from "./metrics.js";

/** Which retrieval surface the harness scores. */
export type EvalTarget = "search" | "pack";

/**
 * Minimal structural contract the harness needs. `SearchService` satisfies
 * it directly; tests can pass a fake without building a full container.
 */
export interface EvalProvider {
  search(input: unknown): Promise<Result<SearchResult[], MonstheraError>>;
  buildContextPack(input: unknown): Promise<Result<ContextPack, MonstheraError>>;
}

export interface EvalCaseResult {
  readonly query: string;
  readonly expected: readonly string[];
  readonly rankedTopK: readonly string[];
  readonly precision: number;
  readonly recall: number;
  readonly ndcg: number;
  readonly reciprocalRank: number;
  readonly error?: string;
}

export interface EvalReport {
  readonly target: EvalTarget;
  readonly k: number;
  readonly caseCount: number;
  readonly aggregate: {
    readonly precisionAtK: number;
    readonly recallAtK: number;
    readonly ndcgAtK: number;
    readonly mrr: number;
  };
  readonly cases: readonly EvalCaseResult[];
}

async function rankedIdsFor(
  provider: EvalProvider,
  target: EvalTarget,
  c: GoldenCase,
  k: number,
): Promise<{ ids: string[]; error?: string }> {
  if (target === "search") {
    const res = await provider.search({ query: c.query, type: c.type ?? "all", limit: Math.max(k, 10) });
    if (!res.ok) return { ids: [], error: `${res.error.code}: ${res.error.message}` };
    return { ids: res.value.map((r) => r.id) };
  }
  const res = await provider.buildContextPack({
    query: c.query,
    mode: c.mode ?? "general",
    type: c.type ?? "all",
    limit: Math.max(k, 8),
  });
  if (!res.ok) return { ids: [], error: `${res.error.code}: ${res.error.message}` };
  return { ids: res.value.items.map((i) => i.id) };
}

/**
 * Run every golden case through the chosen retrieval surface and compute
 * per-case + aggregate P@k, R@k, NDCG@k and MRR. A retrieval error for one
 * case yields zeroed metrics for that case (recorded in `error`) without
 * aborting the run — a single bad query must not hide the rest of the report.
 */
export async function runEval(opts: {
  provider: EvalProvider;
  cases: readonly GoldenCase[];
  target: EvalTarget;
  k: number;
}): Promise<EvalReport> {
  const { provider, cases: goldenCases, target, k } = opts;
  const cases: EvalCaseResult[] = [];

  for (const c of goldenCases) {
    const relevant = new Set(c.expectedArticleIds);
    const { ids, error } = await rankedIdsFor(provider, target, c, k);
    cases.push({
      query: c.query,
      expected: c.expectedArticleIds,
      rankedTopK: ids.slice(0, k),
      precision: round(precisionAtK(ids, relevant, k)),
      recall: round(recallAtK(ids, relevant, k)),
      ndcg: round(ndcgAtK(ids, relevant, k)),
      reciprocalRank: round(reciprocalRank(ids, relevant)),
      ...(error !== undefined ? { error } : {}),
    });
  }

  return {
    target,
    k,
    caseCount: cases.length,
    aggregate: {
      precisionAtK: round(mean(cases.map((c) => c.precision))),
      recallAtK: round(mean(cases.map((c) => c.recall))),
      ndcgAtK: round(mean(cases.map((c) => c.ndcg))),
      mrr: round(mean(cases.map((c) => c.reciprocalRank))),
    },
    cases,
  };
}
