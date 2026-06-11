---
id: k-5xnflq1k
title: Wave E4: hybrid-ranker extraído de search/service.ts — eval idéntico a 4 decimales como arnés
slug: wave-e4-hybrid-ranker-extrado-de-searchservicets-eval-idntico-a-4-decimales-como-arns
category: solution
tags: [wave-e, refactor, file-split, search, hybrid-ranker]
codeRefs: [src/search/service.ts, src/search/hybrid-ranker.ts]
references: [k-e60cayja, k-73ofos2z, k-3zo9w9dg]
createdAt: 2026-06-11T05:47:40.497Z
updatedAt: 2026-06-11T05:47:40.497Z
---

Rama `refactor/e4-hybrid-ranker` desde main post-#168. **Cierra el backlog de splits de la auditoría** (D0 routes/ · E1 rules/ · E2 factories/ · E3 structure modules · E4 hybrid-ranker).

## Diseño

`service.ts` 1084→914; `hybrid-ranker.ts` (222) con las tres etapas post-retrieval como funciones puras con deps explícitas: `mergeResults` (el merge corregido de C1 — su comentario de incidente viaja con el código) · `rerankTopK(rankProfile)` · `applyReranker(query, results, {rerankEnabled, reranker, rankProfile, logger})` (etapa PR-11 fail-open) · `rerankForTrust(query, results, {knowledgeRepo, workRepo})` con `computeTrustAdjustedScore` privado. El `search()` del service conserva repo I/O, config y decisiones de fallback, delegando con deps objects estrechos. `scoreContextPackItem` y los pack builders intactos (fuera de alcance).

Nota de proceso: el subagente asignado murió al instante por límite de cuota — extracción hecha a mano por la sesión principal (el bloque era íntimamente conocido: el fix C1 vive ahí).

## El arnés triple para refactors de ranking

1. Suite de search 137/137 sin tocar aserciones.
2. Coverage completo 2322.
3. **Eval del golden set IDÉNTICO a 4 decimales** contra captura pre-refactor (NDCG 0.8996 / MRR 0.8929 / P 0.1929 / R 0.9911 / contamination 0.7273, engine semantic) — para código de ranking, este es el arnés que de verdad muerde: la suite puede pasar con scores distintos; el eval no.

## Verificación

Gate completo: typecheck 0 · eslint 0 · coverage exit 0 (2322) · corpus lint 0 · audit high 0 · eval-identity ✓.