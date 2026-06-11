---
id: k-talge4d2
title: Wave E1: work/lint.ts partido en rules/ por familia — 871 → 408, findings del corpus byte-idénticos
slug: wave-e1-worklintts-partido-en-rules-por-familia-871-408-findings-del-corpus-byte-idnticos
category: solution
tags: [wave-e, refactor, file-split, lint, rules]
codeRefs: [src/work/lint.ts, src/work/rules/anti-examples.ts, src/work/rules/canonical-values.ts, src/work/rules/shared.ts]
references: [k-gqkb0d2i, k-3zo9w9dg]
createdAt: 2026-06-10T23:42:39.353Z
updatedAt: 2026-06-10T23:42:39.353Z
---

Rama `refactor/e1-lint-rules`, apilada sobre #163. Segundo archivo del backlog de splits (preced.: D0 routes/).

## Diseño

`lint.ts` 871→408: conserva los finding types (unión discriminada), LintScanInput/Result, manejo de exempt-tags, y el loop de composición `scanCorpus`. Siete módulos en `src/work/rules/`: anti-examples (252 — phrase+token drift comparten matchers/guards/levenshtein, van juntos) · verify-density (70) · custom-frontmatter (60) · canonical-values (49) · tag-hygiene (44) · planning-hash (38) · shared (14 — solo `extractLineForIndex`, el único helper usado por DOS familias; los strip-helpers quedaron privados en su única familia).

**Superficie pública intacta**: todos los tipos que importan consumidores siguen físicamente en lint.ts; `DEFAULT_VERIFY_DENSITY_THRESHOLD` se re-exporta (el CLI lo importa de lint.js). Cero cambios en consumidores y tests. Ciclo solo a nivel de tipos (rules → `import type` de lint.js; erasure bajo verbatimModuleSyntax) — sin ciclo runtime.

## Juicios (lo demás verbatim)

- `scanCanonicalValues(body, file, canonicalValues)`: extraído del bloque inline de scanCorpus con firma estrecha; loop de violaciones verbatim.
- `TokenContext` exportado de anti-examples (aparece en firmas exportadas) pero NO re-exportado de lint.ts (nunca fue público).

## La verificación que importa

Además del gate (typecheck 0 · eslint 0 · coverage exit 0 con 2322 · 876 tests de work/tools/cli sin tocar · audit 0): **baseline pre-refactor del lint REAL del corpus capturado ANTES de tocar nada → findings post-refactor byte-idénticos** (5 warnings orphan_citation). Para refactors de "cero cambio de comportamiento" sobre herramientas que procesan datos reales, el diff de output real es evidencia más fuerte que la suite.

## Pausa contractual

Por regla del handoff: E2 (container.ts) / E3 (structure/service.ts) / E4 (search/service.ts) NO arrancan sin review del usuario — un split de 800+ líneas no se encadena a ciegas aunque el gate pase.