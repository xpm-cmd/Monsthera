---
id: k-pupprz0g
title: PR-12: Embedding onboarding ergonomics (M2 close)
slug: pr12-embedding-onboarding
category: solution
tags: [m2, pr-12, cli, embeddings, onboarding, doctor]
codeRefs: [src/cli/self-commands.ts, src/cli/doctor-commands.ts, README.md, tests/unit/cli/self-enable-semantic.test.ts]
references: []
createdAt: 2026-05-31T08:03:56.116Z
updatedAt: 2026-05-31T08:03:56.116Z
---

Sixth and final PR of M2. Makes enabling semantic search a one-liner.

## What shipped (main @ 1d13f64, PR #134)
- `monsthera self enable-semantic` (`src/cli/self-commands.ts`): health-checks the Ollama provider FIRST (refuses to half-enable, surfacing the provider's own actionable "Run: ollama pull <model>" error), then persists `search.semanticEnabled=true` to `<repo>/.monsthera/config.json`, then `fullReindex` to generate embeddings. `--json` supported.
- `monsthera doctor` "Embeddings" section: off → points at `self enable-semantic`; on → reports provider readiness via `healthCheck()`.
- README "Semantic Search" section (BM25-default, two-step opt-in, `MONSTHERA_SEARCH_*` knobs).
- Pure exported `withSemanticEnabled(config)` merge helper (preserves other fields, defensive vs non-object `search`); unit-tested.

## Design choice
Verify-before-mutate: check Ollama health BEFORE writing config, so a missing model never leaves semantic enabled-but-broken. The container only builds the real `OllamaEmbeddingProvider` when `semanticEnabled` (else Stub, dim 0), so doctor + enable-semantic construct an `OllamaEmbeddingProvider` directly from `config.search.{ollamaUrl,embeddingModel}` to get a meaningful health check.

## Gotchas
- Container does NOT expose `embeddingProvider` as a top-level field (only passes it to SearchService deps) → construct one from config for health checks.
- `self` is an existing command (`handleSelf` switch) — added an `enable-semantic` case.

## M2 COMPLETE — all 6 PRs
PR-7 [[pr7-context-pack-ranking-characterization]] (pins) → PR-8 [[pr8-corpus-staleness-report]] → PR-9 [[pr9-contradiction-detection]] → PR-10 [[pr10-config-ranking-knobs]] → PR-11 [[pr11-reranker-stage]] → PR-12 (this). Every ranking stage is now tunable + observable, and `monsthera eval` (default) == `tests/eval/baseline.json` (NDCG@5 1.0, MRR 1.0, P@5 0.2) throughout. Suite grew 2090 → 2163.

NEXT = M3: PR-13 provenance+salience, PR-14 custom-frontmatter query+lint, PR-15 git/PR ingestion.

## Verification (hermetic)
pnpm test 2163 (+4); typecheck/eslint/corpus 0; live smokes pass.