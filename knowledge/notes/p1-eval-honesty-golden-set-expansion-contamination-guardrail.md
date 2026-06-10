---
id: k-n8wdamc0
title: P1 eval honesty — golden-set expansion + contamination guardrail
slug: p1-eval-honesty-golden-set-expansion-contamination-guardrail
category: solution
tags: [eval, golden-set, retrieval, metrics, ndcg, contamination, p1]
codeRefs: []
references: []
createdAt: 2026-06-10T08:47:12.625Z
updatedAt: 2026-06-10T08:47:12.625Z
---

Wave 2 of the 2026-06-10 audit (see [[auditora-integral-2026-06-10-backlog-priorizado-post-m3]], work `w-zluxybat`). Branch `feat/p1-eval-honesty`.

## Problem
`tests/eval/golden/knowledge.json` had 7 cases, each with exactly 1 expected id, scored at k=5. P@5 was mathematically pinned at 0.2, NDCG@5/MRR pinned at 1.0. Moving a result from rank 2 to rank 4 changed no aggregate — the eval was a saturated regression gate that measured nothing.

## What shipped
1. **Schema (`src/eval/golden.ts`)**: added optional `forbiddenArticleIds: z.array(z.string()).optional()`. Distractor ids that must NOT appear in top-k. `expectedArticleIds` stays required-min-1 — a pure no-answer negative would zero P@k/NDCG (empty ideal ranking) and pollute the aggregate; the forbidden list is the cleaner negative signal.
2. **Harness (`src/eval/harness.ts`)**: when a case declares forbidden ids, compute per-case `contamination` = count of forbidden ids in rankedTopK (0=clean). Run-level `aggregate.contaminationRate` = mean over only the cases that declare forbidden ids (`mean([])`→0, so a set with no forbidden reads clean 0). P/R/NDCG/MRR math untouched — purely additive.
3. **Golden set**: expanded 7→**28 cases** across 5 themed files (loadGoldenCases globs all *.json): `knowledge.json` (8), `orchestration.json` (4), `dashboard.json` (5), `search.json` (5), `work.json` (6). Mix: 6 multi-relevant (≥3 expected — convoy cluster, dashboard cluster, work-model cluster, code-intel cluster), 10 single-answer precision anchors, 11 with forbidden lists, 2 type=work. Every id verified against `knowledge/index.md` frontmatter before commit (a wrong id makes loadGoldenCases throw).
4. **CLI (`src/cli/eval-commands.ts`)**: default `--k` 5→10 (multi-relevant cases need a wider window); help text updated. Rendered report shows per-case `C=<n>` (with `!` when >0) and aggregate `CONTAM=`; baseline-delta prints a CONTAM line (guarded for older baselines lacking the field).
5. **Tests (`tests/unit/eval/harness.test.ts`)**: +6 tests (12→18). Multi-relevant case with imperfect ranking yields non-saturated NDCG<1 and P@5=3/5; contamination counted in top-k and aggregated; clean-zero when forbidden absent; omitted when no case declares forbidden.
6. **Baseline regenerated** (`tests/eval/baseline.json`): NOT hand-faked — ran `tsx src/bin.ts eval --json --k 10` and extracted the emitted report. Now **non-saturated**: NDCG@10=0.9512 (was 1.0), MRR=0.9821 (was 1.0), P@10=0.1964, contaminationRate=0.6364. 10 of 28 cases have NDCG<1 (min 0.6509 on the env-snapshot work case, RR=0.5).

## Gotchas / decisions
- **Ollama down in sandbox** → eval ran on BM25 fallback (the "Semantic embedding failed, falling back to BM25" warnings are EXPECTED, not errors). The numbers reflect BM25 ranking and are reproducible (baseline-delta reads all 0.0000 on re-run).
- **`semanticEnabled` in the JSON report is the CONFIG flag, not liveness** — it emitted `true` even though BM25 fallback was actually used per the per-query logs. This is the documented "lie" the broader P1 honesty work targets; this slice did NOT change that flag (left for the liveness-detection follow-up via `EmbeddingProvider.healthCheck()` / the `src/search/service.ts:339` fallback signal). Baseline keeps the field for structural parity with the prior committed baseline, mirroring what eval emitted.
- **Forbidden-list construction**: distractors are semantically adjacent but known-wrong (e.g. ADR-001 storage *decision* forbids the Dolt connection/repo *implementation* notes; the work-phases query forbids dashboard-UI notes; convoy *orchestration* forbids the convoy *dashboard* decision). Contamination only rises if ranking genuinely degrades — at the current BM25 baseline 5 cases already show contamination>0 (e.g. "dual storage" drags 2 Dolt-impl notes into top-10 behind the correctly-#1 ADR), which is exactly the false-positive signal the gate now captures.

## Files
`src/eval/golden.ts`, `src/eval/harness.ts`, `src/cli/eval-commands.ts`, `tests/unit/eval/harness.test.ts`, `tests/eval/baseline.json`, `tests/eval/golden/{knowledge,orchestration,dashboard,search,work}.json`.