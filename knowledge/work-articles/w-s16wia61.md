---
id: w-s16wia61
title: Wave E1: split de work/lint.ts en rules/ por finding type — luego PAUSA para review
template: refactor
phase: planning
priority: medium
author: claude-code
tags: [wave-e, file-split, lint]
references: [k-3zo9w9dg, k-gqkb0d2i]
codeRefs: [src/work/lint.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T23:30:40.945Z
updatedAt: 2026-06-10T23:30:40.945Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T23:30:40.945Z"}]}
---

## Objective

Primer split de Wave E (auditoría P3, precedente: think-synthesis/handoff-renderer y el D0 routes/). `src/work/lint.ts` (~871 líneas) → `src/work/rules/` por finding type. Cero cambio de comportamiento; suite como arnés.

**Regla del handoff: tras E1, PARAR y pedir review del usuario antes de E2-E4** (container.ts, structure/service.ts, search/service.ts) — un refactor de 800+ líneas no se encadena a ciegas aunque el gate pase.

## Acceptance Criteria

- Suite de lint (lint-*.test.ts y consumidores) verde sin tocar aserciones.
- lint.ts reducido a orquestación/composición; un módulo por familia de regla.
- Gate completo + nota solution + PR apilado sobre #163.
- DESPUÉS: pausa explícita — E2-E4 NO arrancan sin OK del usuario.