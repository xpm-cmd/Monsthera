---
id: k-ormciy7d
title: P1 eval honesty — run-level engine detection + doctor liveness
slug: p1-eval-honesty-run-level-engine-detection-doctor-liveness
category: solution
tags: [eval, engine-detection, semantic-search, doctor, liveness, embedding, p1]
codeRefs: []
references: []
createdAt: 2026-06-10T08:55:22.124Z
updatedAt: 2026-06-10T08:55:22.124Z
---

Wave 2 (slice 2) of the 2026-06-10 audit (work `w-zluxybat`, branch `feat/p1-eval-honesty`). Follows the golden-set expansion slice ([[p1-eval-honesty-golden-set-expansion-contamination-guardrail]]).

## The lie this fixes
`monsthera eval` reported `semanticEnabled: container.config.search.semanticEnabled` — a static CONFIG flag. In the 2026-06-10 audit Ollama was DOWN, every query silently fell back to BM25 (`src/search/service.ts:339` logs "Semantic embedding failed, falling back to BM25"), yet eval still printed `semantic=on` with near-perfect metrics. Two runs were not comparable because you couldn't tell which engine actually answered.

## What shipped
1. **Run-level engine detection (`src/eval/harness.ts`)**: new `EvalEngine = "semantic" | "bm25-fallback" | "bm25-disabled" | "unknown"` and `detectEngine(provider, semanticEnabled)`:
   - config disabled → `bm25-disabled` (NO network call)
   - enabled + `healthCheck()` ok → `semantic`
   - enabled + `healthCheck()` err → `bm25-fallback`
   This mirrors SearchService's per-query fallback decision at the run level. `runEval` now takes an optional `engine?: EvalEngine` (defaults `"unknown"` so existing fake-provider unit tests need no change) and stamps it into `EvalReport.engine`. `EvalEmbeddingProbe` is the minimal `{ healthCheck() }` slice the harness needs (EmbeddingProvider satisfies it structurally).
2. **CLI (`src/cli/eval-commands.ts`)**: `handleEval` calls `detectEngine(container.embeddingProvider, semanticEnabled)` BEFORE scoring and passes `engine` into `runEval`. JSON keeps `semanticEnabled` (intent) AND now carries `report.engine` (reality). Rendered header replaced the misleading `semantic=on/off` with `engine=<label> semantic=on/off` — both intent and reality visible.
3. **Container accessor (`src/core/container.ts`)**: exposed the already-constructed `embeddingProvider` as a readonly field on `MonstheraContainer`. Minimal — exposes one existing dependency, does not widen surface. doctor previously RECONSTRUCTED a fresh `OllamaEmbeddingProvider` from config; both eval and doctor now probe the REAL wired provider (the same instance SearchService holds).
4. **doctor (`src/cli/doctor-commands.ts`)**: extracted a pure exported `renderEmbeddingDiagnostic({semanticEnabled, modelName, dimensions, embeddingModel, health})` (testable without a container). When semantic is enabled but `healthCheck()` fails, it names the silent BM25 fallback and prints the exact remediation: ``run `ollama pull <model>` (and ensure Ollama is running), or set MONSTHERA_SEMANTIC_ENABLED=false``.
5. **Tests**: harness +5 (`detectEngine` x3 — disabled-no-probe / ok→semantic / err→bm25-fallback; `runEval` stamps engine + defaults unknown). New `tests/unit/cli/doctor-embedding-diagnostic.test.ts` (+4 — disabled, ready, unreachable-remediation, model-name-in-pull). Targeted `vitest run tests/unit/eval tests/unit/cli` = 8 files / 147 tests green; broader `tests/unit/{eval,cli,core,search}` = 33 files / 430 green.
6. **Baseline (`tests/eval/baseline.json`)**: regenerated via `tsx src/bin.ts eval --json --k 10` (NOT hand-faked). Now carries top-level `"engine": "bm25-fallback"` (the engine it was captured under in this Ollama-down sandbox) plus `semanticEnabled: true`. Deltas read 0.0000 on re-run; output is deterministic across two runs.

## Decisions / gotchas
- **status left as config+index (deliberate).** `container.ts` `semanticSearchEnabled` stat stays `semanticEnabled && embeddingCount>0` ("configured + has vectors"), NOT liveness. A live `healthCheck()` there would put an HTTP call to Ollama on EVERY `createContainer`, i.e. on every read-only `monsthera status` — adding network latency + an offline failure mode to a hot path. Liveness belongs in `doctor` (diagnostic, latency acceptable) and `eval` (engine=…). Documented with a code comment at the stat. Correctness over feature-completeness.
- **Baseline drift was corpus, not code.** The regenerated baseline's recall dropped 1.0→0.9821 vs the prior committed baseline on one case ("convoy single-convoy invariant hardening…") because the previous slice's own knowledge note `k-n8wdamc0` now indexes and BM25-ranks at position 8, pushing the expected `k-convoy-requires-resync-design-decisions` off the bottom of top-10. The fresh numbers are the honest current corpus state and are reproducible.
- **Why a pure render helper for doctor**: testing the unreachable-provider branch through `main()` requires a real Dolt-backed container; extracting `renderEmbeddingDiagnostic` makes the remediation message a true unit test, mirroring `detectEngine`'s testability.

## Files
`src/eval/harness.ts`, `src/cli/eval-commands.ts`, `src/cli/doctor-commands.ts`, `src/core/container.ts`, `tests/unit/eval/harness.test.ts`, `tests/unit/cli/doctor-embedding-diagnostic.test.ts`, `tests/eval/baseline.json`.