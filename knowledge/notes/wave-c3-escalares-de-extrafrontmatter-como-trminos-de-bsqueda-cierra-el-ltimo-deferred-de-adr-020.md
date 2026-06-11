---
id: k-v9l1e8qa
title: Wave C3: escalares de extraFrontmatter como términos de búsqueda — cierra el último deferred de ADR-020
slug: wave-c3-escalares-de-extrafrontmatter-como-trminos-de-bsqueda-cierra-el-ltimo-deferred-de-adr-020
category: solution
tags: [wave-c, search, custom-frontmatter, adr-020, indexing]
codeRefs: [src/search/service.ts, tests/unit/search/cf-search-terms.test.ts]
references: [k-73ofos2z, k-3zo9w9dg]
createdAt: 2026-06-10T12:40:11.031Z
updatedAt: 2026-06-10T12:40:40.184Z
---

Rama `feat/c3-cf-search-terms`, apilada sobre #158. Cierra el deferred "cf search-term emission" de M3 (diferido por dudas de tokenizer). El filtro `--filter custom.<k><op><v>` ya funcionaba; el índice no veía los valores — `search("replicability")` no encontraba un artículo con `replicability_score: 0.85`.

## Diseño

`buildIndexContent(content, codeRefs, extraFrontmatter?)` anexa una línea `key value` por entrada ESCALAR (string/number/boolean) — mismo patrón que los codeRefs anexados. El tokenizer (split en no-alfanuméricos) parte `replicability_score` en `replicability` + `score` naturalmente: la duda del tokenizer que motivó el deferral se resuelve sola con el formato `key value` plano. **Arrays/objects se omiten deliberadamente** (tokens aplanados sin ancla de campo = ruido) — pineado por test. Tres call sites de knowledge (index único, upsert de fullReindex, embeddings de fullReindex); work no tiene extraFrontmatter.

## Verificación

TDD 3-red→green + pin de no-emisión para no-escalares + roundtrip update/reindex (quitar una entrada cf hace caer sus términos del índice). **Eval vs baseline C1: P/R/MRR/contamination idénticos, NDCG −0.0002** (jitter de IDF por longitud de documento; nivel ruido — los ADRs del corpus llevan `origin: ingested` y ganan 2 tokens). Smoke CLI: `search "ingested"` surfacea los artículos de provenance. Gate completo: typecheck 0 · eslint 0 · coverage exit 0 (2318 tests) · corpus lint 0 · audit high 0.

## Estado de ADR-020 tras esto

Authoring (P1) ✅ · query/filter (P2) ✅ · lint (P3) ✅ · **search-term emission ✅ (este PR)**. El ADR queda sin deferreds.