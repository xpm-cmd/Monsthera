---
id: k-896cica1
title: Decisión G2: forbidden por staleness caduca con el refresh del artículo — re-revisión post-D3 del golden set
slug: decisin-g2-forbidden-por-staleness-caduca-con-el-refresh-del-artculo-re-revisin-post-d3-del-golden-set
category: decision
tags: [wave-g, eval, golden-set, retrieval-quality]
codeRefs: [tests/eval/golden/dashboard.json, tests/eval/golden/work.json, tests/eval/golden/orchestration.json, tests/eval/golden/search.json, tests/eval/baseline.json]
references: [w-j7ao5fak, k-zuks8lor, k-73ofos2z]
createdAt: 2026-06-11T11:24:47.680Z
updatedAt: 2026-06-11T11:24:47.680Z
---

Cierra w-j7ao5fak. Rama `chore/g2-golden-forbidden-rereview`.

## El criterio general

**Un `forbiddenArticleIds` cuya razón depende del CONTENIDO del artículo (staleness, claims falsas, alcance) debe re-evaluarse cada vez que ese artículo se refresca.** Un refresh puede falsificar la razón registrada de dos maneras: corrigiendo claims desactualizadas, o **cambiando el alcance de la nota** (el caso real encontrado aquí). En cambio, un forbidden cuya razón es **topical** (la nota pertenece a otro dominio que el que la query busca) sobrevive a cualquier refresh: la frescura no cambia el dominio.

Corolario operativo: al re-revisar, la pregunta no es "¿la nota es buena ahora?" sino "¿la razón registrada sigue describiendo la nota?". El campo `note` de cada caso DEBE registrar la razón con suficiente precisión para que esta pregunta sea decidible — y los re-reviews se marcan inline con fecha.

## Hallazgo que corrigió la premisa del work item

La hipótesis de w-j7ao5fak ("varias estaban forbidden porque estaban desactualizadas") resultó falsa: las 11 entradas forbidden del golden set (nacido entero en `6e9f518`, keystone C) tienen razones **topicales**, ninguna de staleness. Pero UNA quedó falsificada por otra vía: el refresh D3 le añadió a k-2jb9bh3p (SPA routing) la sección del backend (composition root ~190 líneas, `routes/*.ts`, route chain) — "frontend, not the HTTP API surface" dejó de describirla.

## Veredictos por caso (los 4 casos con notas dashboard-* refrescadas)

| Caso | Forbidden | Veredicto |
|---|---|---|
| dashboard "rest api endpoints routes" | k-2jb9bh3p | **QUITADO** — post-refresh documenta el router del servidor; respuesta parcial legítima (neutral, no expected: k-kmnflb56 sigue siendo la referencia) |
| dashboard "rest api endpoints routes" | k-imz9hai0 | Mantenido — UI primitives puro, cero contenido REST |
| orchestration "wave planning batching" | k-2jb9bh3p, k-l7oy85r0 | Mantenidos — cero contenido de waves/batching/dispatch |
| search "ranking bm25 semantic trust" | k-kmnflb56, k-imz9hai0 | Mantenidos — superficie API ≠ internals de ranking; UI ≠ ranking |
| work "model phases guards reviewers" | k-2jb9bh3p, k-5nuw1j8i, k-imz9hai0 | Mantenidos — k-5nuw1j8i ahora renderiza semántica del lifecycle (NEXT_PHASE, skip-guard) pero sigue siendo doc de page-UX, no el spec del modelo |

Los 7 casos forbidden restantes no involucran notas refrescadas en D3 → sin trigger de re-evaluación (fuera de scope).

## Efecto medido (mismo corpus, mismo engine, mismo día)

Pre→post cirugía: P/R/NDCG/MRR **idénticos a 4 decimales** (0.1857/0.9613/0.8885/0.8929) — esperado: solo usan expected ids. Contamination **0.7273→0.6364** (−1 unidad de conteo; el rate es media de CONTEOS por caso sobre los 11 casos con forbidden, resolución 0.0909). Baseline recapturado con la config que shippea (engine semantic, corpus de hoy) — absorbe además el drift de corpus desde la captura C1 (NDCG 0.8989→0.8885, recall 0.9911→0.9613, P 0.1929→0.1857: las waves D/E/F/G1 agregaron ~16 notas; lección de k-73ofos2z aplicada).