---
id: k-9dsf5kqm
title: Solution: Wave E1: split de work/lint.ts en rules/ por finding type — luego PAUSA para review
slug: distilled-w-s16wia61
category: solution
tags: [wave-e, file-split, lint, distilled]
codeRefs: [src/work/lint.ts]
references: [w-s16wia61]
createdAt: 2026-06-11T00:14:50.486Z
updatedAt: 2026-06-11T00:14:50.486Z
origin: distilled
distilled_from: w-s16wia61
---

> Distilled from work [w-s16wia61] on completion. Origin: `distilled`.

## Objective

(Original en historial.) Split de `src/work/lint.ts` → `src/work/rules/`, cero cambio de comportamiento, luego PAUSA contractual.

## Status 2026-06-10 — E1 COMPLETO, PAUSA ACTIVA

PR #164 (`refactor/e1-lint-rules`), nota k-talge4d2. lint.ts 871→408; 7 módulos rules/ (anti-examples 252 · verify-density 70 · custom-frontmatter 60 · canonical-values 49 · tag-hygiene 44 · planning-hash 38 · shared 14). Superficie pública intacta (cero ediciones en consumidores/tests). Doble arnés: 876 tests sin tocar + **findings del lint real byte-idénticos al baseline pre-refactor**. Gate completo verde (2322 tests).

**PAUSA CONTRACTUAL EN EFECTO**: E2 (core/container.ts, 681) · E3 (structure/service.ts, 1260) · E4 (search/service.ts, ~1090) esperan review explícito del usuario. Wave F (backlog opcional) también post-review.

## Code
- `src/work/lint.ts`
