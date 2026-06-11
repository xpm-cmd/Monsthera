---
id: w-j7ao5fak
title: Golden set: re-revisar forbiddenArticleIds de casos dashboard tras el refresh D3
template: spike
phase: done
priority: low
author: claude-code
tags: [eval, golden-set, follow-up, wave-d]
references: [k-73ofos2z, k-zuks8lor]
codeRefs: [tests/eval/golden/dashboard.json, tests/eval/baseline.json]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T23:29:32.042Z
updatedAt: 2026-06-11T11:28:31.182Z
enrichmentRolesJson: {"items":[]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T23:29:32.042Z","exitedAt":"2026-06-11T11:20:13.728Z"},{"phase":"enrichment","enteredAt":"2026-06-11T11:20:13.728Z","exitedAt":"2026-06-11T11:28:31.182Z"},{"phase":"done","enteredAt":"2026-06-11T11:28:31.182Z","reason":"Spike solo-agent merge-as-you-go: cierre = PR #175 mergeado (5dc95d3) con CI verde 1m46s + gate completo local; AC cumplidos — veredicto por caso documentado en golden notes + decision note + baseline recapturado.","metadata":{"pr":175,"merged_sha":"5dc95d3","decision_note":"k-896cica1","contamination":"0.7273→0.6364","relevance":"idéntica a 4 decimales pre/post"}}]}
completedAt: 2026-06-11T11:28:31.182Z
---

## Objective

El cierre de Wave D midió contamination 0.7273→0.8182 con P/R/MRR/NDCG estables. Causa: D3 refrescó las 7 notas `dashboard-*` (abril→hoy) vía update_article — varias estaban en `forbiddenArticleIds` de casos del golden set **porque estaban desactualizadas** (claims falsas de auth/CORS/nav). Post-refresh son precisas y frescas, y vuelven a rankear: el label "forbidden" quedó él mismo stale.

Decidir por caso: (a) quitar el forbidden si la razón era "contenido desactualizado" ya corregido; (b) mantenerlo si la razón era otra (p.ej. duplicación con una nota canónica). Recapturar baseline tras el ajuste. Es cirugía del eval: cada cambio del golden set re-define el gate — un PR pequeño con justificación por caso.

## Acceptance Criteria

- Cada forbidden de los casos dashboard con justificación explícita (mantener o quitar).
- Baseline recapturado; contamination refleja juicios vigentes, no históricos.
- Nota decision con el criterio general: "forbidden por staleness" debe re-evaluarse cuando el artículo se refresca.