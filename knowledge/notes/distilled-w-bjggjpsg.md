---
id: k-24mp31p1
title: Solution: Wave C: calidad de recuperación — fix-or-quarantine semantic, baseline honesto, salience, cf emission
slug: distilled-w-bjggjpsg
category: solution
tags: [wave-c, eval, retrieval-quality, semantic, distilled]
codeRefs: [src/search/service.ts, tests/eval/baseline.json, tests/eval/golden/knowledge.json, src/core/runtime-state.ts]
references: [w-bjggjpsg]
createdAt: 2026-06-11T00:14:39.828Z
updatedAt: 2026-06-11T00:14:39.828Z
origin: distilled
distilled_from: w-bjggjpsg
---

> Distilled from work [w-bjggjpsg] on completion. Origin: `distilled`.

## Objective

(Ver historial: C1 reformulado por el descubrimiento del colapso semántico en el cierre de Wave A.)

- **C1** — fix-or-quarantine eval-gated del ranking semántico + baseline honesto.
- **C2** — salience implementar-o-descartar.
- **C3** — escalares de extraFrontmatter como términos de búsqueda.

## Acceptance Criteria — TODOS CUMPLIDOS

- bm25-only byte-idéntico ✅ (0.8767 exacto, verificado).
- Caracterización de scoreContextPackItem intacta ✅.
- Decisión C1 por números ✅ (SHIP: semantic 0.098→0.8989 NDCG, supera bm25 +0.022/+0.045 recall).
- C2 ✅ decisión DESCARTAR (k-r51xph09): inmedible por construcción (eval stateless), contraindicado por evidencia C1 (familia de boosts query-independientes), amplificaría contaminación.
- C3 ✅ roundtrip tests + eval sin degradación (NDCG −0.0002 ruido).

## Status 2026-06-10 — wave completa, PRs abiertos

- C1 → PR #157 (`fix/c1-hybrid-scale-mismatch`), nota k-73ofos2z. Causa raíz: mismatch de escala en mergeResults ([0,1] vs boosts calibrados a escala cruda) + cosenos clusterizados. Fix: stretch per-query + re-escalado ×maxBm25. Baseline recapturado (engine: semantic, corpus actual). **Regresión divulgada: contamination 0.7273 vs 0.5455 bm25** — palanca: currency demotion en trust reranker (frente abierto).
- C2 → PR #158 (`docs/c2-salience-discard`), nota k-r51xph09 (decision). Deferred PR-13b cerrado para siempre.
- C3 → PR #159 (`feat/c3-cf-search-terms`), nota k-v9l1e8qa. ADR-020 sin deferreds.

Pendiente para `done`: merge del stack #157/#158/#159.

## Code
- `src/search/service.ts`
- `tests/eval/baseline.json`
- `tests/eval/golden/knowledge.json`
- `src/core/runtime-state.ts`
