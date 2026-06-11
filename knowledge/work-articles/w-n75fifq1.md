---
id: w-n75fifq1
title: H1 — Repository cache: matar el O(corpus-parse) por lookup en knowledge file-repository
template: refactor
phase: implementation
priority: high
author: claude-code
tags: [wave-h, performance, repository, cache]
references: [k-p90ik5jo, k-73ofos2z]
codeRefs: [src/knowledge/file-repository.ts, src/work/file-repository.ts, src/knowledge/repository.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T11:52:53.027Z
updatedAt: 2026-06-11T12:19:45.469Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"contributed","contributedAt":"2026-06-11T12:19:03.943Z"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T11:52:53.027Z","exitedAt":"2026-06-11T11:57:42.471Z"},{"phase":"enrichment","enteredAt":"2026-06-11T11:57:42.471Z","metadata":{"branch":"perf/h1-repository-cache","pre_eval_captured":"/tmp/wh_eval_pre_h1.json","baseline_drift_note":"live corpus drifted vs tests/eval/baseline.json (NDCG 0.8965 vs 0.8885, MRR 0.9107 vs 0.8929, P/R/contamination identical) — corpus-driven, gate will be same-corpus A/B old-code vs new-code"},"exitedAt":"2026-06-11T12:19:45.469Z"},{"phase":"implementation","enteredAt":"2026-06-11T12:19:45.469Z","metadata":{"recon":"workflow 4 agentes: mutation-risk/work-repo/findbyslug-dependents/test-landscape","tdd_rounds":"3 (stat-cache 13 tests, repo integration 6, slug-identity 2)"}}]}
---

## Objective

Todo lookup del knowledge file-repository re-parsea el corpus entero (`loadAll()` = readdir + readFile + parseMarkdown de cada `.md`) en cada `findById`/`findBySlug`/`findMany`/`findByCategory`/`findByTag`; `update()` lo hace ≥3 veces. A 147 artículos es tolerable; a 1K+ se arrastra. Introducir cache in-process con invalidación por stat (readdir + mtime/size por archivo, re-parse solo lo cambiado) sin romper la semántica multi-proceso (CLI y MCP server comparten archivos) ni las escrituras externas (corpora Option-A dropean archivos directo + `status()`).

## Acceptance Criteria

- (a) Corpus sintético ~1000 notas: timing antes/después de `knowledge get <id>` y context pack documentado en el PR (evidencia, NO test de CI).
- (b) Suite completa verde (typecheck 0, eslint 0, coverage exit 0, corpus lint exit 0).
- (c) Eval idéntico a 4 decimales vs `tests/eval/baseline.json` (refactor de read-path puro).
- (d) Smoke con el corpus real del repo.
- (e) Multi-proceso: stat-check por operación, no TTL ciego; escrituras externas detectadas; cero archivos fantasma en reads; invalidación tras writes propios.
- (f) Verificar si `src/work/file-repository.ts` comparte el patrón: cubrir si es barato, si no registrar follow-up con AC.
- (g) Evaluar disolver la dualidad de findBySlug (fast-path path-derivado vs frontmatter como única verdad) — decisión consciente + test + documentación; tests de fallback de G1 siguen verdes.