---
id: k-lyyxwlnf
title: Decisión H3: embedding input ponderado descartado — la hipótesis del boilerplate quedó falsificada por el A/B
slug: decisin-h3-embedding-input-ponderado-descartado-la-hiptesis-del-boilerplate-qued-falsificada-por-el-ab
category: decision
tags: [wave-h, semantic, embeddings, retrieval-quality, eval]
codeRefs: [src/search/service.ts, src/search/embedding.ts, tests/eval/baseline.json]
references: [w-19jefagr, k-73ofos2z, k-a5gjeblo, k-sqb6um9l]
createdAt: 2026-06-11T22:24:50.123Z
updatedAt: 2026-06-11T22:24:50.123Z
---

Cierra w-19jefagr. Spike implementar-o-descartar: **DESCARTADO con código revertido y entorno restaurado** — el A/B same-corpus falsificó la hipótesis. Tercer descarte del linaje C2 (salience) → G3 (demotion) → H3, cada uno cerrado con medición, no con opinión.

## El trigger SÍ disparó (a diferencia de G3)

Post-H2 el eval expandido observaba debilidad semántica medible: 5 casos con NDCG semantic < bm25 (peor: "search ranking bm25 semantic hybrid trust reranking", 0.765 vs 0.885) y contamination agregada peor (0.5952 vs 0.5238). La palanca registrada desde C1: `generateAndStoreEmbedding` embebe `title + content.slice(0,500)` y el boilerplate inicial del corpus (wave notes "Cierra w-X. Rama…", ADRs con bloque Status/Date/Deciders) produciría vectores casi idénticos cross-tema.

## El experimento (opción 1: input ponderado por campo)

`buildEmbeddingInput(title, tags, content)`: tags antepuestos + ventana de 500 chars INICIANDO después del bloque de boilerplate (regex de leading block: openers "Cierra/Closes w-…" y líneas bold-metadata ADR). TDD 7 tests verdes, cableado en los 4 call sites. Reindex completo: `monsthera reindex`, **52s** (~195 embeddings, nomic-embed-text local). A/B same-corpus, cero writes entre runs, bm25 **byte-idéntico** pre/post (guard C1: el cambio tocó SOLO el input de embeddings).

## El veredicto, medido

| agregado (semantic) | PRE (vectores viejos) | POST (nuevos) | delta |
|---|---|---|---|
| P@10 | 0.1814 | 0.1837 | +0.0023 |
| R@10 | 0.9748 | 0.9864 | +0.0116 |
| NDCG@10 | 0.9161 | 0.9233 | +0.0072 |
| MRR | 0.9419 | 0.9419 | 0 |
| **contamination (norm.)** | **0.5952** | **0.6667** | **+0.0715 PEOR** |

- **Casos hard: CERO mejoras.** Los 5 casos que motivaron el spike quedaron con métricas idénticas — salvo el peor, que EMPEORÓ (NDCG 0.765→0.704).
- **Mecanismo del daño**: los tags en el input colapsan familias same-tag en el espacio vectorial — el caso "convoy orchestration design dispatch waves resync" pasó de contamination 0→1 filtrando `k-convoy-dashboard-design-decisions` (comparte tags convoy). Lo contrario de lo que el guardrail de contamination existe para proteger.
- La única ganancia (recall +0.0116, NDCG +0.007 difuso en casos fáciles) no compra el trade.

## Por qué descartar y no iterar (opciones 2-3)

La falsificación es mecanística: si el prefijo boilerplate fuera el problema, des-boilerplatearlo habría movido los casos hard — no movió NI UNO. La debilidad semántica de esos casos vive en otra parte (candidatos: pesos del hybrid merge, trust rerank, query-side). Un slice más largo (opción 2) diluiría más; chunking+pooling (opción 3) es caro para 0.12 de headroom concentrado en UN caso. Contrato implementar-o-descartar → descartar.

## Estado del entorno

Código revertido (la rama spike murió sin mergear; main intacto). Re-reindex con código de main (51s): eval post-restauración con agregados Y métricas per-case **idénticos** al PRE; único residuo un reshuffle de cola (ranks 5-10) en un caso por empates de score — sin tocar expected/forbidden.

## Condición de reapertura

Re-abrir SOLO si el golden set (que crece por régimen k-sqb6um9l) acumula ≥3 casos donde semantic pierde contra bm25 en MRR (no solo NDCG de cola) Y el diff de contaminantes por engine muestra pares cuyos textos difieren principalmente en el prefijo embebido. Hasta entonces, el siguiente sospechoso para los casos hard es el lado del RANKING (pesos del merge híbrido / trust rerank), no el input de embeddings.