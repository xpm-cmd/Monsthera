---
id: w-6fpupnwl
title: H2 — Des-saturar el eval: contamination normalizada + golden set 28→40+ + régimen operativo
template: feature
phase: implementation
priority: high
author: claude-code
tags: [wave-h, eval, golden-set, retrieval-quality]
references: [k-896cica1, k-a5gjeblo, k-73ofos2z]
codeRefs: [src/eval/harness.ts, tests/eval/golden/knowledge.json, tests/eval/baseline.json]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T12:49:49.454Z
updatedAt: 2026-06-11T13:04:30.122Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"contributed","contributedAt":"2026-06-11T13:01:10.660Z"},{"role":"testing","agentId":"claude-code","status":"contributed","contributedAt":"2026-06-11T13:01:11.158Z"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T12:49:49.454Z","exitedAt":"2026-06-11T13:00:48.127Z"},{"phase":"enrichment","enteredAt":"2026-06-11T13:00:48.127Z","metadata":{"branch":"feat/h2-eval-desaturation","mining":"scripts/mine-golden-cases.mts contra engine vivo, 16 queries candidatas, 15 casos viables"},"exitedAt":"2026-06-11T13:04:30.122Z"},{"phase":"implementation","enteredAt":"2026-06-11T13:04:30.122Z","reason":"Guard snapshot_ready falla por BUG de timezone en el round-trip Dolt (capturedAt 13:02:54Z grabado → 03:02:54Z releído, -10h = offset Sydney → stale:true para un snapshot de 1 minuto). Snapshot real s-lg8chk5c SÍ existe, es fresco y sus lockfile hashes coinciden con HEAD. Bug registrado como work item con AC.","skippedGuards":["snapshot_ready"],"metadata":{"tdd":"3 reds de normalización verificados + pin viejo de conteo volteado consciente","golden":"28→43 casos, 14 guarded, 80 ids validados existentes","saturation":"MRR diverge 0.9419 vs 0.9186, 16 casos discriminan","snapshot":"s-lg8chk5c","bug_found":"snapshot capturedAt TZ round-trip"}}]}
---

## Objective

(a) **Normalizar contamination**: hoy es media de CONTEOS crudos por caso (un caso con 3 forbidden puede aportar 3.0; otro máximo 1.0; resolución 0.0909 con 11 casos — G3 colgó de "1 unidad"). Redefinir por-caso como `hits/|forbidden|` en [0,1] vía TDD sobre src/eval/harness.ts, manteniendo el conteo crudo como campo secundario para comparar histórico. (b) **Crecer el golden set 28→40+** rompiendo la saturación (MRR 0.8929 idéntico en ambos engines): hard negatives reales minados del engine vivo (diff por engine de k-a5gjeblo como material), casos para las notas wave-c..g+H (hoy casi sin casos), casos multi-relevantes NDCG-significativos, 2-3 forbidden nuevos con disciplina k-896cica1 (razón TOPICAL o content-dependent EXPLÍCITA en el note, decidible en re-review). (c) **El régimen** (la parte "para siempre"): decision note con la regla operativa de mantenimiento del golden set.

## Acceptance Criteria

- Golden 40+ casos, todos con `note` justificando expected/forbidden.
- Contamination normalizada con TDD (red→green verificado); conteo crudo preservado como secundario.
- Baseline recapturado (engine semantic) post-redefinición; ambos engines medidos y documentados.
- Decision note del régimen operativo (cadencia de expansión, trigger de saturación, re-review de forbidden).
- Los agregados pueden BAJAR — no es regresión, es vara más dura: pre/post documentado como "nuevo punto de partida"; el gate mantener-o-mejorar se evalúa contra el baseline NUEVO de aquí en adelante.
- Opcional si barato: warning en `monsthera doctor` cuando ratio corpus/casos pase umbral.
- Gates estándar completos.