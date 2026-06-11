---
id: w-19jefagr
title: H3 (spike) — Embedding input: title + tags + contenido des-boilerplateado, implementar-o-descartar
template: spike
phase: done
priority: medium
author: claude-code
tags: [wave-h, semantic, embeddings, retrieval-quality]
references: [k-73ofos2z, k-a5gjeblo, k-sqb6um9l]
codeRefs: [src/search/service.ts, src/search/embedding.ts, tests/eval/baseline.json]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T22:16:04.027Z
updatedAt: 2026-06-11T22:27:55.433Z
enrichmentRolesJson: {"items":[]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T22:16:04.027Z","exitedAt":"2026-06-11T22:25:00.629Z"},{"phase":"enrichment","enteredAt":"2026-06-11T22:25:00.629Z","metadata":{"experiment":"buildEmbeddingInput TDD 7 tests + reindex 52s + A/B same-corpus","bm25_guard":"byte-identical pre/post"},"exitedAt":"2026-06-11T22:27:55.433Z"},{"phase":"done","enteredAt":"2026-06-11T22:27:55.433Z","reason":"Spike cerrado por descarte medido (contrato implementar-o-descartar): A/B same-corpus falsificó la hipótesis, código revertido, entorno re-reindexado y verificado idéntico; CI verde del PR de veredicto (1m44s). Sin reviewer humano en flujo single-agent.","metadata":{"pr":181,"merged_sha":"c1a1751","nota":"k-lyyxwlnf","verdict":"DISCARDED — 0/5 casos hard mejoraron, contamination +0.0715, tags colapsan familias same-tag","reindex_restore":"51s, verificado idéntico al PRE"}}]}
completedAt: 2026-06-11T22:27:55.433Z
---

## Objective

Trigger evaluado post-H2: DISPARA. El eval expandido (43 casos) ahora SÍ observa debilidad semántica específica: 5 casos con NDCG semantic < bm25 (peor: "search ranking bm25 semantic hybrid trust reranking" 0.765 vs 0.885, gap 0.12) y contamination agregada peor (0.5952 vs 0.5238 normalizada). La palanca: `generateAndStoreEmbedding` (src/search/service.ts:686) embebe `title + content.slice(0,500)` — el boilerplate inicial (wave notes abren con "Cierra w-X. Rama…", ADRs con bloques **Status:**/**Date:**/**Deciders:**) produce vectores casi idénticos cross-tema (tercer factor latente de C1, k-73ofos2z).

Opción 1 (la más barata): input ponderado por campo — `title + tags + primeros 500 chars del contenido SALTANDO el bloque inicial de boilerplate`. Opciones 2-3 (slice más largo, chunking+pooling) solo si la 1 falla y el headroom lo justifica.

## Acceptance Criteria (contrato implementar-o-descartar)

- TDD del builder puro (`buildEmbeddingInput`): salta líneas "Cierra w-…", bloques de metadata ADR en el LEADING block (no en el cuerpo), antepone tags, cap 500.
- Reindex completo de embeddings documentado (comando + duración).
- A/B same-corpus: eval semantic PRE-reindex (vectores viejos) vs POST-reindex (vectores nuevos), cero writes de artículos entre runs.
- **Gate de ship**: NDCG/MRR mantener-o-mejorar agregado Y mejora medible en los casos hard de H2 (los 5 NDCG-down + contamination). Si no → revert + decision note (precedente G3) + re-reindex para dejar el entorno consistente con lo mergeado.
- **bm25-only byte-idéntico** pre/post (guard de C1): el cambio toca SOLO el input de embeddings; el run bm25 sobre el mismo corpus debe ser idéntico.
- Al cerrar (ship O descarte): embeddings del entorno en estado consistente con main.