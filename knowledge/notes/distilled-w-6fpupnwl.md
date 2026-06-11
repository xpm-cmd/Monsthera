---
id: k-278rsyhw
title: Solution: H2 — Des-saturar el eval: contamination normalizada + golden set 28→40+ + régimen operativo
slug: distilled-w-6fpupnwl
category: solution
tags: [wave-h, eval, golden-set, retrieval-quality, distilled]
codeRefs: [src/eval/harness.ts, tests/eval/golden/knowledge.json, tests/eval/baseline.json]
references: [w-6fpupnwl]
createdAt: 2026-06-11T22:15:02.937Z
updatedAt: 2026-06-11T22:15:02.937Z
origin: distilled
distilled_from: w-6fpupnwl
---

> Distilled from work [w-6fpupnwl] on completion. Origin: `distilled`.

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

## Code
- `src/eval/harness.ts`
- `tests/eval/golden/knowledge.json`
- `tests/eval/baseline.json`
