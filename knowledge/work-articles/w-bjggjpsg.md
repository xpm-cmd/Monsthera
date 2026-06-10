---
id: w-bjggjpsg
title: Wave C: calidad de recuperación — fix-or-quarantine semantic, baseline honesto, salience, cf emission
template: feature
phase: planning
priority: high
author: claude-code
tags: [wave-c, eval, retrieval-quality, semantic]
references: [k-3zo9w9dg]
codeRefs: [src/search/service.ts, tests/eval/baseline.json, tests/eval/golden/knowledge.json, src/core/runtime-state.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T12:22:58.065Z
updatedAt: 2026-06-10T12:22:58.065Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"},{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T12:22:58.065Z"}]}
---

## Objective

El plan original de C1 ("recapturar baseline con semantic real") quedó invalidado por el descubrimiento del cierre de Wave A: **el engine semantic colapsa el golden set** (NDCG@10 0.098 vs 0.877 bm25, pre-existente en main). Diagnóstico (2 experimentos + lectura de código):

1. Input de embedding pobre: `title + content.slice(0,500)` → los 21 ADRs comparten boilerplate → ~21 vectores casi idénticos en 60-82% de los top-10 (ranking query-independiente).
2. **Mismatch de escala (causa dominante)**: `mergeResults` produce baseScore ∈ [0,1] (alpha-mix normalizado) mientras `scoreContextPackItem` suma boosts estáticos de hasta ~+4 calibrados para la escala bm25 cruda (5-15) → en híbrido los boosts aplastan la señal de búsqueda 4:1.
3. Coseno con rango dinámico comprimido (~0.45-0.65 entre candidatos) — poco discriminativo sin normalización per-query.

- **C1 (reformulado)** — fix-or-quarantine eval-gated: re-escalado del score híbrido a magnitud bm25 + min-max per-query del coseno en `mergeResults`. SHIP si semantic-pack NDCG ≥ nivel bm25 (0.8767); si no, quarantine documentado. Baseline recapturado honesto (corpus actual) + nota con la primera medición real del valor de los embeddings.
- **C2** — salience implementar-o-descartar (contrato original; requiere C1 resuelto para que el eval sea juez válido).
- **C3** — emitir escalares de `extraFrontmatter` como términos de búsqueda (no debe degradar eval; tests de roundtrip).

## Acceptance Criteria

- bm25-only byte-idéntico (path no tocado; eval bm25 = 0.8767 exacto).
- Tests de caracterización de `scoreContextPackItem` verdes sin cambios.
- Decisión C1 (ship o quarantine) tomada por números del golden set, documentada en nota solution.
- C2: mejora medible o código descartado + decision note (descartar cierra el deferred para siempre).
- C3: roundtrip tests + eval sin degradación.
- Gate completo por PR; stack continúa.