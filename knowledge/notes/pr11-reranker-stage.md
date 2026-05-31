---
id: k-ovlxucc1
title: PR-11: Relevance reranker stage
slug: pr11-reranker-stage
category: solution
tags: [m2, pr-11, search, reranker, ranking, llm]
codeRefs: [src/search/reranker.ts, src/search/service.ts, src/core/container.ts, tests/unit/search/reranker-stage.test.ts]
references: []
createdAt: 2026-05-31T07:54:46.867Z
updatedAt: 2026-05-31T07:54:46.867Z
---

Fifth PR of M2. Optional relevance-reranking stage for hybrid search; consumes the `rerankEnabled`/`rankProfile` knobs from PR-10.

## What shipped (main @ 6ef089b, PR #133)
- `Reranker` interface (`src/search/reranker.ts`) mirrors `EmbeddingProvider`: `rerank(query, candidates) → Result<RerankScore[]>` + `healthCheck` + `name`. Returns a [0,1] relevance per candidate.
- Stage in `SearchService.search()` between `mergeResults` and `rerankForTrust`, behind `rerankEnabled`. `applyReranker` reweights `score = hybrid * relevance`, re-sorts the top-K (`rankProfile`: conservative 10 / balanced 20 / tokenmax 40).
- `StubReranker` (default) returns neutral **1.0** for all → `score * 1.0` = exact no-op. `CrossEncoderReranker` scores via `container.textGenerator` (LLM), parsed by tolerant `parseRerankScores`.
- Container builds CrossEncoder when `rerankEnabled`, else Stub; injects via `setReranker` (mirrors `setTextGenerator`).

## Critical design insight (the trap I hit)
`rerankForTrust` runs AFTER the reranker and **re-sorts by `score`**. So a reranker that only REORDERS gets clobbered. The fix: the reranker must influence the SCORE, not just order. Chose a **multiplicative reweight** `score = hybrid * relevance[0,1]`:
- Stub returns 1.0 → score unchanged → trust rerank sees today's exact scores → **exact no-op** (this is why "stub == disabled" and the eval baseline both hold).
- CrossEncoder returns [0,1] → down-weights low-relevance hits; trust adjustments then apply on top.
A purely-reordering stage would have been silently undone by `rerankForTrust`.

## Fail-open
Disabled flag, no reranker, unhealthy reranker, or rerank `err` → return input order. A flaky LLM can never break `search`. In hermetic/semantic-off runs the stage isn't reached (it's in the semantic-on path) → eval baseline preserved exactly.

## Acceptance (eval gate)
- Stub == disabled order (integration test). Cross-encoder reorders top hits. Failing reranker degrades (no crash). `monsthera eval` default == `tests/eval/baseline.json` (NDCG@5 1.0, MRR 1.0, P@5 0.2).

## Gotchas
- `EmbeddingProvider` requires `embedBatch` + `modelName`; `TextGenerator` requires `modelName` — test fakes must implement them (vitest runs via esbuild and won't catch missing members; `tsc` will, so always run `pnpm typecheck` not just the tests).
- `consistent-type-imports` eslint rule: a value-import used only as a type errors — use `import { type X, Y }`.

## Verification (hermetic)
pnpm test 2159 (+15); typecheck/eslint/corpus 0.

Builds on [[pr10-config-ranking-knobs]] and [[pr7-context-pack-ranking-characterization]].