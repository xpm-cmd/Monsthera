---
id: k-73ofos2z
title: Wave C1: el colapso semántico era un mismatch de escala — NDCG 0.098 → 0.899, semantic ahora supera a bm25
slug: wave-c1-el-colapso-semntico-era-un-mismatch-de-escala-ndcg-0098-0899-semantic-ahora-supera-a-bm25
category: solution
tags: [wave-c, retrieval-quality, semantic, eval, hybrid-ranking]
codeRefs: [src/search/service.ts, tests/unit/search/hybrid-merge.test.ts, tests/eval/baseline.json, src/search/embedding.ts]
references: [k-3zo9w9dg]
createdAt: 2026-06-10T12:32:49.694Z
updatedAt: 2026-06-10T12:32:49.694Z
---

Rama `fix/c1-hybrid-scale-mismatch`, apilada sobre #156. **La primera medición real del valor de los embeddings sobre el golden set expandido** (28 casos, k=10 — el baseline anterior se capturó con Ollama caído, en bm25-fallback).

## La medición que nadie había hecho

Con semantic encendido: **NDCG@10 0.098 / MRR 0.046** vs 0.877/0.893 de bm25-only. El canary de status decía "ok" todo el tiempo (mide vida del pipeline, no calidad de ranking).

## Diagnóstico (3 experimentos)

1. **NO eran los prefijos de nomic** — probe vivo: coseno crudo separa relevante/irrelevante +0.19; con prefijos `search_query:`/`search_document:` +0.15 (no mejora).
2. **Ranking query-independiente** — análisis de rankedTopK de los 28 casos: los 15 ADRs importados ese día aparecían en 60-82% de TODOS los top-10 ("ADR soup"); solo 50 artículos distintos en 280 slots.
3. **Causa raíz: mismatch de escala** — `mergeResults` emitía scores alpha-mixed en [0,1] mientras bm25-only emite magnitudes CRUDAS (5-15); `scoreContextPackItem` suma boosts estáticos de hasta ~+4 calibrados implícitamente contra la escala cruda → con semantic on, los boosts aplastaban la señal 4:1. Factor agravante: cosenos clusterizados (~0.45-0.65) = término casi constante sin información de orden. (Tercer factor latente, NO tocado aquí: el input de embedding es `title + content.slice(0,500)` — boilerplate de ADRs produce vectores casi idénticos.)

## Fix (solo path híbrido; bm25-only byte-idéntico, verificado 0.8767 exacto)

En `mergeResults`: (1) **min-max stretch del coseno PER QUERY** sobre el candidate set; (2) **re-escalado del mix a magnitud bm25** (`× maxBm25`). Fórmula: `(α·normBm25 + (1−α)·stretchedCos) · maxBm25`.

## Resultado (golden set, k=10)

| | bm25-only | semantic ANTES | semantic DESPUÉS |
|---|---|---|---|
| NDCG@10 | 0.8767 | 0.0979 | **0.8989** |
| MRR | 0.8929 | 0.0465 | **0.8929** |
| Recall@10 | 0.9464 | 0.2589 | **0.9911** |
| Contamination | 0.5455 | 0.0909¹ | 0.7273 ⚠️ |

¹ vacuamente baja: no surfaceaba NADA relevante ni prohibido.

**Decisión: SHIP** (semantic ≥ bm25 en NDCG/recall/MRR). **Regresión conocida divulgada:** contamination 0.73 vs 0.55 — semantic surfacea notas superseded-pero-temáticas (dashboard-* de abril, dolt notes viejas): similitud ≠ vigencia. Palanca siguiente: demotion por currency en el trust reranker (NO perseguido aquí; scope C2+).

## Baseline recapturado

`tests/eval/baseline.json` ahora refleja la config que shippea (engine: semantic, corpus de HOY). El viejo (NDCG 0.9449) era doblemente stale: engine equivocado Y corpus pre-import de ADRs — la propia recomendación P2 de la auditoría movió bm25-only a 0.8767. Lección: **el baseline debe recapturarse en cada cambio de corpus significativo, o el gate "mantener-o-mejorar" se vuelve insatisfacible para cambios no-op.**

## Verificación

TDD 2-red→green (magnitud de escala + flip end-to-end del boost-domination con corpus de masa realista — en corpus de 2 docs el IDF es tan bajo que los boosts dominan legítimamente). Caracterización de `scoreContextPackItem` intacta. Gate completo: typecheck 0 · eslint 0 · coverage exit 0 (2314 tests) · corpus lint 0 · audit high 0.