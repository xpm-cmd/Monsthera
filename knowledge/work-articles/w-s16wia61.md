---
id: w-s16wia61
title: Wave E1: split de work/lint.ts en rules/ por finding type — luego PAUSA para review
template: refactor
phase: done
priority: medium
author: claude-code
tags: [wave-e, file-split, lint]
references: [k-3zo9w9dg, k-gqkb0d2i]
codeRefs: [src/work/lint.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T23:30:40.945Z
updatedAt: 2026-06-11T00:14:50.309Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T23:30:40.945Z","exitedAt":"2026-06-11T00:14:46.556Z"},{"phase":"enrichment","enteredAt":"2026-06-11T00:14:46.556Z","exitedAt":"2026-06-11T00:14:47.803Z","reason":"AC original en historial; cumplido en PR #164","skippedGuards":["has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-06-11T00:14:47.803Z","exitedAt":"2026-06-11T00:14:49.053Z","reason":"solo-agente: doble arnés (876 tests + lint real byte-idéntico, k-talge4d2)","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-06-11T00:14:49.053Z","reason":"implementación en PR #164 mergeado vía #165","skippedGuards":["implementation_linked"],"exitedAt":"2026-06-11T00:14:50.309Z"},{"phase":"done","enteredAt":"2026-06-11T00:14:50.309Z","reason":"review en GitHub: CI verde + merge autorizado; pausa contractual cumplida y levantada","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-06-11T00:14:50.309Z
---

## Objective

(Original en historial.) Split de `src/work/lint.ts` → `src/work/rules/`, cero cambio de comportamiento, luego PAUSA contractual.

## Status 2026-06-10 — E1 COMPLETO, PAUSA ACTIVA

PR #164 (`refactor/e1-lint-rules`), nota k-talge4d2. lint.ts 871→408; 7 módulos rules/ (anti-examples 252 · verify-density 70 · custom-frontmatter 60 · canonical-values 49 · tag-hygiene 44 · planning-hash 38 · shared 14). Superficie pública intacta (cero ediciones en consumidores/tests). Doble arnés: 876 tests sin tocar + **findings del lint real byte-idénticos al baseline pre-refactor**. Gate completo verde (2322 tests).

**PAUSA CONTRACTUAL EN EFECTO**: E2 (core/container.ts, 681) · E3 (structure/service.ts, 1260) · E4 (search/service.ts, ~1090) esperan review explícito del usuario. Wave F (backlog opcional) también post-review.