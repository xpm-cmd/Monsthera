---
id: w-j7unmtos
title: Wave G3 (condicional): demotion por vigencia en rerankForTrust — evaluar trigger post-G2 e implementar-o-descartar
template: spike
phase: enrichment
priority: low
author: claude-code
tags: [wave-g, eval, retrieval-quality, hybrid-ranking]
references: [k-73ofos2z, k-896cica1]
codeRefs: [src/search/hybrid-ranker.ts, tests/eval/baseline.json]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T11:29:03.819Z
updatedAt: 2026-06-11T11:29:13.227Z
enrichmentRolesJson: {"items":[]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T11:29:03.819Z","exitedAt":"2026-06-11T11:29:13.227Z"},{"phase":"enrichment","enteredAt":"2026-06-11T11:29:13.227Z"}]}
---

## Objective

Item condicional del handoff Wave G: solo si, post-G2, contamination sigue significativamente peor en semantic que en bm25-only, implementar demotion por vigencia/supersession en `rerankForTrust` (la palanca nombrada en k-73ofos2z) bajo contrato implementar-o-descartar estilo C2: si NDCG/MRR no se mantienen y contamination no mejora de forma medible → descartar el código + decision note.

## Acceptance Criteria

- Trigger evaluado con números reales post-G2: contamination semantic vs bm25-only (`MONSTHERA_SEMANTIC_ENABLED=false`), mismo corpus, mismo k.
- Si dispara: TDD sobre las funciones puras de hybrid-ranker (E4), eval gate mantener-o-mejorar, deltas documentados.
- Si no dispara o se descarta: decision note con el análisis mecanístico que cierra el frente.