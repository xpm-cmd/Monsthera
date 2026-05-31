---
id: k-gtgddgs3
title: PR-10: Config-driven ranking knobs
slug: pr10-config-ranking-knobs
category: solution
tags: [m2, pr-10, search, config, ranking, bm25]
codeRefs: [src/core/config.ts, src/search/in-memory-repository.ts, src/context/insights.ts, src/search/service.ts, src/core/container.ts]
references: []
createdAt: 2026-05-31T07:38:54.260Z
updatedAt: 2026-05-31T07:38:54.260Z
---

Fourth PR of M2; prerequisite for PR-11's reranker.

## What shipped (main @ 2fc7013, PR #132)
Six ranking parameters lifted into `SearchConfigSchema` (`src/core/config.ts`), each `.default()` to its old hardcoded value (unset config = today's ranking → PR-7 pins stay green):
- `bm25K1` (1.2), `titleBoost` (3.0) → `InMemorySearchIndexRepository` (new constructor `tuning?`, defaults = old `BM25_K1`/`TITLE_BOOST` consts; container passes `config.search.*`).
- `freshnessFreshDays` (14), `freshnessStaleDays` (45) → `inspectKnowledgeArticle`/`inspectWorkArticle` optional opts (default 14/45 via `freshnessFromAge` default params); `SearchService` passes configured values. NOTE: `StructureService.buildStalenessReport` stays on defaults (doesn't see search config).
- `rerankEnabled` (false), `rankProfile` (conservative|balanced|tokenmax, default balanced) → **schema-only; PR-11 consumes them**.
Env: `MONSTHERA_SEARCH_*` (BM25K1, TITLE_BOOST, FRESHNESS_FRESH_DAYS, FRESHNESS_STALE_DAYS, RERANK_ENABLED, RANK_PROFILE). Unparseable numerics ignored (schema default applies) so a typo never crashes config load.

## Reusable gotcha (important for future config additions)
Adding `.default()` fields makes them **required in the zod OUTPUT type** (`z.infer`), which breaks every test that builds an inline `config` literal with only the old fields (5 test files broke). Two fixes used:
1. Relax the consumer's dep type: `SearchServiceDeps.config` = `Omit<MonstheraConfig["search"], RankingKnob> & Partial<Pick<..., RankingKnob>>` — the service tolerates missing knobs (falls back to inspect* defaults), container still passes full config. Zero test churn.
2. For a full-MonstheraConfig literal (integration test), spread the defaults: `search: { ...defaultConfig(cwd).search, ...overrides }`.
Prefer (1) when the consumer only reads a subset; prefer building test config via the schema otherwise.

## Acceptance evidence
- `bm25K1` alters BM25 scores: unit test (`in-memory-repository-tuning.test.ts`).
- `bm25K1` alters ranking at the eval surface: `monsthera eval --json` `retrievedIds` reorder under `MONSTHERA_SEARCH_BM25K1=50`. Aggregate metrics stay 1.0 only because the golden top-1 is unambiguous (saturated) — the broader ranking demonstrably moves.
- Defaults preserve PR-7 pins + full suite (2144) green.

## Verification (hermetic)
pnpm test 2144 (+11); typecheck/eslint/corpus 0.

Builds on [[pr7-context-pack-ranking-characterization]]; unblocks PR-11 reranker (rerankEnabled/rankProfile).