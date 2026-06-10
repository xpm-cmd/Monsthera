---
id: w-ymavjqkd
title: Wave A: quick fixes consumer-driven — update() ID-named duplica + GUARD_FAILED mudo
template: bugfix
phase: planning
priority: high
author: claude-code
tags: [wave-a, consumer-driven, banyan]
references: [k-3zo9w9dg, k-zv7qfvll, k-e9atys0k]
codeRefs: [src/knowledge/file-repository.ts, src/work/guards.ts, src/cli/work-commands.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T11:28:58.838Z
updatedAt: 2026-06-10T11:28:58.838Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T11:28:58.838Z"}]}
---

## Objective

Dos quick fixes consumer-driven descubiertos en el workstream Banyan 2026-06-10 (ver k-3zo9w9dg):

- **A1** — `update()` sobre un artículo cuyo archivo es ID-named (consumidor Option-A, ej. `k-91-HB-037-<slug>.md`) escribe un archivo NUEVO `<slug>.md` y deja el original (gotcha registrado en k-zv7qfvll). Desde PR-16 existe `KnowledgeArticle.filePath` runtime — el write path debe reusarlo cuando está presente.
- **A2** — `GUARD_FAILED: min_enrichment_met` no nombra los roles pendientes ni el remedio (fricción registrada en k-e9atys0k). El mensaje debe enumerar roles pendientes + sugerir `work enrich <id> --role <r> --status contributed|skipped` (o `--skip-guard-reason`). stderr sigue siendo el canal.

## Acceptance Criteria

- A1: TDD — update sobre fixture ID-named modifica el MISMO archivo, cero duplicados; rename explícito (`new_slug`) sigue funcionando. Gate completo verde.
- A2: TDD sobre guards + un test CLI; el mensaje enumera roles pendientes y el remedio exacto. Gate completo verde.
- 1 PR pequeño + 1 knowledge note (categoría solution) por fix. PRs apilados (tocan knowledge/).
- Sin regresión en `monsthera eval` al cierre de la wave.