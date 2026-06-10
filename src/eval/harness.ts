import type { Result } from "../core/result.js";
import type { MonstheraError } from "../core/errors.js";
import type { ContextPack } from "../search/service.js";
import type { SearchResult } from "../search/repository.js";
import type { GoldenCase } from "./golden.js";
import { precisionAtK, recallAtK, ndcgAtK, reciprocalRank, mean, round } from "./metrics.js";

/** Which retrieval surface the harness scores. */
export type EvalTarget = "search" | "pack";

/**
 * Which retrieval engine ACTUALLY answered the run, as opposed to the
 * configured intent (`semanticEnabled`). Two runs are only comparable when
 * they were produced by the same engine, so this label travels with the
 * report and the regenerated baseline.
 *
 *   - `semantic`      — semantic search is enabled AND the embedding provider
 *                       passed a live `healthCheck()`, so hybrid ranking ran.
 *   - `bm25-fallback` — semantic search is enabled but the provider failed its
 *                       healthCheck (e.g. Ollama down); every query silently
 *                       fell back to BM25. Metrics reflect keyword ranking.
 *   - `bm25-disabled` — semantic search is turned off in config; BM25 by design.
 *   - `unknown`       — engine was not determined (e.g. a harness unit test that
 *                       passes a fake provider and does not call `detectEngine`).
 */
export type EvalEngine = "semantic" | "bm25-fallback" | "bm25-disabled" | "unknown";

/**
 * Minimal structural contract the harness needs. `SearchService` satisfies
 * it directly; tests can pass a fake without building a full container.
 */
export interface EvalProvider {
  search(input: unknown): Promise<Result<SearchResult[], MonstheraError>>;
  buildContextPack(input: unknown): Promise<Result<ContextPack, MonstheraError>>;
}

/**
 * The slice of an `EmbeddingProvider` the harness needs to tell whether the
 * semantic path is *operational* (not merely configured). `EmbeddingProvider`
 * satisfies it structurally; tests pass a fake whose `healthCheck` returns
 * `ok`/`err` to drive the engine label.
 */
export interface EvalEmbeddingProbe {
  healthCheck(): Promise<Result<{ ready: true }, MonstheraError>>;
}

/**
 * Determine the engine that will ACTUALLY answer this run, before scoring.
 *
 * This is the fix for eval's historical lie: it used to report
 * `semanticEnabled` (a static config flag) as if it were the engine, so when
 * Ollama was down every query fell back to BM25 yet the report still said
 * "semantic=on" with perfect metrics. We resolve reality here:
 *   - config disabled            → `bm25-disabled` (no network call)
 *   - config enabled + health ok → `semantic`
 *   - config enabled + health err→ `bm25-fallback`
 *
 * The live `healthCheck()` mirrors the per-query fallback decision in
 * `SearchService` (the "Semantic embedding failed, falling back to BM25"
 * signal) at the run level, so the label matches what every query did.
 */
export async function detectEngine(
  provider: EvalEmbeddingProbe,
  semanticEnabled: boolean,
): Promise<EvalEngine> {
  if (!semanticEnabled) return "bm25-disabled";
  const health = await provider.healthCheck();
  return health.ok ? "semantic" : "bm25-fallback";
}

export interface EvalCaseResult {
  readonly query: string;
  readonly expected: readonly string[];
  readonly rankedTopK: readonly string[];
  readonly precision: number;
  readonly recall: number;
  readonly ndcg: number;
  readonly reciprocalRank: number;
  /**
   * Number of `forbiddenArticleIds` that leaked into `rankedTopK` (0 = clean).
   * Present only when the case declares a forbidden list; a precision/
   * false-positive guardrail that is fully independent of P/R/NDCG/MRR.
   */
  readonly contamination?: number;
  readonly error?: string;
}

export interface EvalReport {
  readonly target: EvalTarget;
  readonly k: number;
  readonly caseCount: number;
  /**
   * The engine that actually answered this run (see {@link EvalEngine}).
   * Distinct from the configured intent — `bm25-fallback` means semantic was
   * enabled but unreachable, so the metrics below reflect BM25 ranking.
   * Defaults to `"unknown"` when the caller does not supply one.
   */
  readonly engine: EvalEngine;
  readonly aggregate: {
    readonly precisionAtK: number;
    readonly recallAtK: number;
    readonly ndcgAtK: number;
    readonly mrr: number;
    /**
     * Mean `contamination` over only the cases that declare a forbidden list.
     * 0 when no case declares one (so a golden set without forbidden ids reads
     * a clean 0). Reported separately from the relevance metrics.
     */
    readonly contaminationRate: number;
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
  /**
   * The engine answering this run, resolved by {@link detectEngine}. Stamped
   * onto the report so consumers (CLI header, committed baseline) can tell
   * which engine produced the metrics. Defaults to `"unknown"` so existing
   * callers (harness unit tests with a fake provider) need no change.
   */
  engine?: EvalEngine;
}): Promise<EvalReport> {
  const { provider, cases: goldenCases, target, k, engine = "unknown" } = opts;
  const cases: EvalCaseResult[] = [];
  const contaminationScores: number[] = [];

  for (const c of goldenCases) {
    const relevant = new Set(c.expectedArticleIds);
    const { ids, error } = await rankedIdsFor(provider, target, c, k);
    const rankedTopK = ids.slice(0, k);

    let contamination: number | undefined;
    if (c.forbiddenArticleIds !== undefined && c.forbiddenArticleIds.length > 0) {
      const forbidden = new Set(c.forbiddenArticleIds);
      contamination = rankedTopK.reduce((n, id) => (forbidden.has(id) ? n + 1 : n), 0);
      contaminationScores.push(contamination);
    }

    cases.push({
      query: c.query,
      expected: c.expectedArticleIds,
      rankedTopK,
      precision: round(precisionAtK(ids, relevant, k)),
      recall: round(recallAtK(ids, relevant, k)),
      ndcg: round(ndcgAtK(ids, relevant, k)),
      reciprocalRank: round(reciprocalRank(ids, relevant)),
      ...(contamination !== undefined ? { contamination } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  }

  return {
    target,
    k,
    caseCount: cases.length,
    engine,
    aggregate: {
      precisionAtK: round(mean(cases.map((c) => c.precision))),
      recallAtK: round(mean(cases.map((c) => c.recall))),
      ndcgAtK: round(mean(cases.map((c) => c.ndcg))),
      mrr: round(mean(cases.map((c) => c.reciprocalRank))),
      // mean() returns 0 for an empty list, so a golden set with no forbidden
      // declarations reads a clean 0 rather than NaN.
      contaminationRate: round(mean(contaminationScores)),
    },
    cases,
  };
}
