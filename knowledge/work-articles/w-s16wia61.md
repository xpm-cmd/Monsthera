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
updatedAt: 2026-06-10T23:43:25.856Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T23:30:40.945Z"}]}
---

## Objective

(Original en historial.) Split de `src/work/lint.ts` → `src/work/rules/`, cero cambio de comportamiento, luego PAUSA contractual.

## Status 2026-06-10 — E1 COMPLETO, PAUSA ACTIVA

PR #164 (`refactor/e1-lint-rules`), nota k-talge4d2. lint.ts 871→408; 7 módulos rules/ (anti-examples 252 · verify-density 70 · custom-frontmatter 60 · canonical-values 49 · tag-hygiene 44 · planning-hash 38 · shared 14). Superficie pública intacta (cero ediciones en consumidores/tests). Doble arnés: 876 tests sin tocar + **findings del lint real byte-idénticos al baseline pre-refactor**. Gate completo verde (2322 tests).

**PAUSA CONTRACTUAL EN EFECTO**: E2 (core/container.ts, 681) · E3 (structure/service.ts, 1260) · E4 (search/service.ts, ~1090) esperan review explícito del usuario. Wave F (backlog opcional) también post-review.