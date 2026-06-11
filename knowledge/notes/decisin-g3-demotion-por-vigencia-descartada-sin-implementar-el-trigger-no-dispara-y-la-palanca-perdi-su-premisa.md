---
id: k-a5gjeblo
title: Decisión G3: demotion por vigencia descartada sin implementar — el trigger no dispara y la palanca perdió su premisa
slug: decisin-g3-demotion-por-vigencia-descartada-sin-implementar-el-trigger-no-dispara-y-la-palanca-perdi-su-premisa
category: decision
tags: [wave-g, eval, retrieval-quality, hybrid-ranking]
codeRefs: [src/search/hybrid-ranker.ts, tests/eval/baseline.json]
references: [w-j7unmtos, k-73ofos2z, k-896cica1, k-r51xph09]
createdAt: 2026-06-11T11:29:40.648Z
updatedAt: 2026-06-11T11:29:40.648Z
---

Cierra w-j7unmtos. Wave G3 era condicional: "solo si, post-G2, contamination sigue significativamente peor en semantic que en bm25-only". **Veredicto: no dispara — frente cerrado sin escribir código**, el caso más barato del contrato implementar-o-descartar (el análisis mecanístico demuestra que la palanca apunta a una causa que ya no existe).

## El trigger, medido (mismo corpus, mismo día, k=10, golden post-G2)

| | semantic | bm25-only |
|---|---|---|
| NDCG@10 | **0.8885** | 0.8738 |
| Recall@10 | **0.9613** | 0.9464 |
| MRR | 0.8929 | 0.8929 |
| Contamination | 0.6364 | 0.5455 |

Gap de contamination = 0.0909 = **exactamente 1 unidad de conteo** — la resolución mínima del métrico (media de conteos por caso sobre 11 casos con forbidden). Un gap igual al cuanto del métrico no es "significativamente peor", y semantic domina en relevancia (+0.015 NDCG, +0.015 recall).

## Por qué la palanca perdió su premisa (análisis por id)

Diff de contaminantes entre engines:

- **Solo-semantic:** k-imz9hai0 (UI library, refrescada 2026-06-10 — **máximamente fresca**: una demotion por vigencia/supersession no puede dispararse sobre ella) y k-u16rujhn (abril — demotable por edad en principio).
- **Solo-bm25:** k-convoy-dashboard-design-decisions — bm25 contamina donde semantic no.
- Compartidos: 4 hits (las notas Dolt ×2, k-pupprz0g, k-5nuw1j8i, k-acodv9lb).

La premisa de k-73ofos2z ("semantic surfacea notas superseded-pero-temáticas") fue disuelta por el refresh D3 + la corrección de juicio de G2: la contamination residual exclusiva de semantic es **similitud cross-dominio de notas frescas y vigentes** — exactamente lo que el golden set discriminante existe para penalizar, y que ninguna señal de vigencia puede distinguir.

Riesgo de implementarla igual: demotar por edad golpearía colateralmente a los **expected** viejos-pero-canónicos (ADR-001 k-acodv9lb, k-klbt2h37/k-2njgnd6v son de abril Y son respuestas esperadas en knowledge[1]/work[3]) — alta probabilidad de romper el gate mantener-o-mejorar de NDCG para cazar 1 unidad de conteo. Y no hay metadata de supersession en el corpus para una demotion quirúrgica (ningún `superseded_by` en frontmatter).

## El opcional (embedding input title+content.slice(0,500)) tampoco se persigue

Sigue registrado como tercer factor latente en k-73ofos2z. No medible hoy: requiere reindex completo de embeddings y el golden set está casi saturado en MRR (0.8929 ambos engines) — la misma lógica de medibilidad que descartó PR-13b salience (k-r51xph09). Si el corpus crece hasta que la saturación se rompa, re-evaluar entonces.

## Condición de reapertura

Re-abrir solo si contamination semantic vs bm25 diverge ≥2 unidades de conteo en un eval mismo-corpus, Y los contaminantes exclusivos de semantic son artículos efectivamente stale/superseded (no frescos cross-dominio).