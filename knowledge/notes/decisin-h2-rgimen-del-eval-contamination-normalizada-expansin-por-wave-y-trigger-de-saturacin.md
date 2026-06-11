---
id: k-sqb6um9l
title: Decisión H2: régimen del eval — contamination normalizada, expansión por wave y trigger de saturación
slug: decisin-h2-rgimen-del-eval-contamination-normalizada-expansin-por-wave-y-trigger-de-saturacin
category: decision
tags: [wave-h, eval, golden-set, retrieval-quality, regimen, baseline]
codeRefs: [src/eval/harness.ts, tests/eval/baseline.json, scripts/mine-golden-cases.mts, tests/eval/golden/retrieval-quality.json]
references: [w-6fpupnwl, k-896cica1, k-a5gjeblo, k-73ofos2z, k-n8wdamc0]
createdAt: 2026-06-11T12:59:46.772Z
updatedAt: 2026-06-11T13:06:24.427Z
---

Cierra w-6fpupnwl. Rama `feat/h2-eval-desaturation`. Esta nota es el contrato operativo del eval de aquí en adelante — las reglas sobreviven a la wave.

## Lo que cambió en H2

**(a) Contamination normalizada.** Por-caso pasa de conteo crudo a `hits/|forbidden|` en [0,1] — antes un caso con 3 forbidden podía aportar 3.0 al agregado mientras otro maxeaba en 1.0, y la resolución del rate (0.0909 con 11 casos) hizo que G3 colgara de "1 unidad". El conteo crudo sobrevive como serie secundaria (`contaminationHits` por caso, `contaminationHitsPerCase` agregado) para continuidad histórica. TDD red→green sobre src/eval/harness.ts; el pin viejo del conteo se volteó conscientemente.

**(b) Golden 28→43 casos (14 guarded).** 15 casos nuevos minados contra el engine VIVO con `scripts/mine-golden-cases.mts` (clona la llamada exacta del harness). Cobertura nueva: el arco retrieval-quality completo (C1/C2/G2/G3), file-repository (G1/H1/H4/T5/A1), corpus-hygiene (tag hygiene, PR-16/17, provenance+ADR-020), ingestion-sessions (PR-15/F5, sistema de handoffs). 3 casos guarded nuevos con razones TOPICALES estilo k-896cica1: staleness-tooling ≠ ranking-demotion (k-2jeulllv/k-5gwkhix1), distillate-stub ≠ nota canónica (k-d7m7jhus, razón de provenance que sobrevive refresh), instancias de handoff ≠ diseño del sistema (k-5umd9fff/k-gsxgt3qx — el flooding de instancias era el 40% del top-10 minado).

## Resultado: la saturación está rota

| | baseline viejo (28 casos) | semantic (43) | bm25 (43) |
|---|---|---|---|
| P@10 | 0.1857 | 0.1814 | 0.1791 |
| R@10 | 0.9613 | 0.9748 | 0.9651 |
| NDCG@10 | 0.8885 | 0.9176 | 0.8931 |
| MRR | 0.8929 (== bm25) | **0.9419** | **0.9186** |
| contamination | 0.6364 (conteo, 11 guarded) | 0.5952 (norm., 14) | 0.5238 (norm., 14) |
| hits/caso (serie vieja) | 0.6364 | 0.8571 | 0.7857 |

MRR dejó de ser idéntico entre engines; **16 casos discriminan**. Semantic gana claro (salience NDCG 1.0 vs 0.631; convoy-dashboard MRR 1.0 vs 0.5) y bm25 gana algunos ("search ranking…trust" NDCG 0.885 vs 0.765 — headroom semántico medible, insumo del trigger H3). El baseline NUEVO es el punto de partida: los números no son comparables 1:1 con la serie vieja (más casos + métrica redefinida) — no es regresión ni mejora, es otra vara.

*Nota de captura:* la tabla refleja el run de medición durante la expansión; el `tests/eval/baseline.json` COMITEADO es la recaptura final con todos los writes del PR en el corpus (esta nota incluida) y lee NDCG 0.9180 con el resto idéntico — esa es el ancla del gate, no la tabla.

## El régimen (las reglas operativas)

1. **Expansión por wave**: toda wave que agregue ≥5 notas al corpus agrega ≥1 caso golden, minado con `scripts/mine-golden-cases.mts` (nunca a ojo), con `note` que justifique expected y forbidden.
2. **Re-review de forbidden**: todo refresh de una nota que aparezca en algún `forbiddenArticleIds` dispara re-review bajo el criterio k-896cica1 — la pregunta es "¿la razón registrada sigue describiendo la nota?", y el re-review se anota inline con fecha. Razones topicales/de-provenance sobreviven; content-dependent caducan.
3. **Trigger de saturación**: MRR semantic == bm25 a 4 decimales en 2 recapturas consecutivas de baseline → expansión obligatoria con hard negatives minados (el estado pre-H2 era exactamente esto y G3/PR-13b murieron por inmedibles).
4. **Gate mantener-o-mejorar**: SIEMPRE contra el baseline vigente (same-engine, same-corpus). Una redefinición de métrica o expansión del set recaptura baseline y resetea el punto de comparación — documentando pre/post en la nota del PR.
5. **Ambos engines en cada recaptura**: el run bm25 (`MONSTHERA_SEMANTIC_ENABLED=false`) se documenta junto al semantic — el diff por engine es la materia prima de los hard negatives y del trigger H3-style.

## Descartes documentados

- **Warning en doctor (corpus/casos ratio)**: descartado — no hay infraestructura de warnings donde colgarlo barato y duplicaría con señal más cruda lo que la regla 3 hace con precisión. Re-evaluar solo si el régimen falla en la práctica.
- **Gap encontrado**: el worktree-fallback (primary-wins, visibilidad cross-branch) NO tiene nota canónica — la query minada no tenía expected posible (solo tests y el comentario del código). Candidato a nota si el tema vuelve a surgir.
- **Bug encontrado de paso**: el guard `snapshot_ready` (ADR-006) falla siempre en hosts al este de UTC — `capturedAt` pierde el timezone en el round-trip Dolt y los snapshots frescos nacen stale. Registrado con AC en w-arq1yroe.