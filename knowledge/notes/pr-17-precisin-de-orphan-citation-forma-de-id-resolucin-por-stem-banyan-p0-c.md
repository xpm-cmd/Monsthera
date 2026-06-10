---
id: k-x4xfniba
title: PR-17: precisión de orphan_citation — forma de ID + resolución por stem (Banyan P0-C)
slug: pr-17-precisin-de-orphan-citation-forma-de-id-resolucin-por-stem-banyan-p0-c
category: solution
tags: [banyan, lint, orphan-citation, consumer-driven, wikilink]
codeRefs: [src/structure/wikilink.ts, src/structure/service.ts, tests/unit/structure/inline-article-ids.test.ts, tests/unit/structure/orphan-citations.test.ts]
references: [k-3zo9w9dg, k-zv7qfvll]
createdAt: 2026-06-10T10:02:17.113Z
updatedAt: 2026-06-10T10:02:17.113Z
---

Segundo fix consumer-driven Banyan (ver [[pr-16-index-navegable-filepath-runtime-exclusin-gitignore-aware-banyan-p0-ab]]). Rama `feat/banyan-p0c-orphan-precision`. El matcher de orphan_citation flageaba términos matemáticos (`k-successor-star`) como citas rotas y no resolvía citas por stem (`k-90-03` → id completo `k-90-03-polyhedral-integrality-wall`).

## Regla de forma de ID (capa de extracción, wikilink.ts)

Un token `k-…`/`w-…` en prosa solo es candidato a cita si su PRIMER segmento tras el prefijo contiene un dígito: `k-10-01`, `k-91-HB-013`, `k-3zo9w9dg` ✓; `k-successor-star`, `k-means` ✗. **Bonus encontrado por el RED:** el charclass viejo era lowercase-only y truncaba `k-91-HB-013` a `k-91` — ahora los segmentos uppercase se capturan completos. Tradeoff documentado en código: ids sin dígito (`k-canonical-values`) pierden detección en prosa desnuda pero siguen cubiertos por frontmatter `references:` y wikilinks (nunca shape-filtrados). Consecuencia en el corpus propio: el warning de `w-abc` desaparece (misma clase FP), `k-abc123` se retiene (con dígito).

## Resolución por prefijo de stem (capa de resolución, getGraph)

Una ref que no matchea exacto id/slug resuelve si algún id empieza con `ref + "-"` — el guión final es boundary guard (`k-10-0` NO resuelve a `k-10-01-…`). Array de ids ordenado precomputado una vez por getGraph; el hit crea una **arista de referencia real** (refs incoming/outgoing ven las citas por stem, no solo se suprime el orphan); match solo-a-sí-mismo resuelve sin self-loop. Uniforme para knowledge y work.

## 13 tests viejos codificaban el bug

9 en inline-article-ids (fixtures sin dígito como `k-policy-example-security` — literalmente la clase FP), 3 en orphan-citations, 1 en ref-graph — reescritos deliberadamente con ids digit-bearing y comentario nombrando la regla P0-C. El mid-run lo probó: implementación dentro, exactamente esos 13 fallaron.

## Aceptación cross-repo (clon Banyan, branch docs/roadmap-and-wave-spec)

BEFORE (fix stasheado, dist pre-fix): 6 orphans — `k-successor`, `k-successor-star` (×2), stems `k-90-03`, `k-80-01` (×2). AFTER: **0 orphans**. Control plantado `k-99-99-ghost` → flagea exactamente 1; revert → 0. Stem real verificado: prosa `k-90-03` resuelve a `k-90-03-polyhedral-integrality-wall`.

## Verificación

typecheck 0 · eslint 0 · coverage EXIT 0 (lines 72.71 / branches 61.41 / functions 81.8) · **2274 passed | 3 skipped** (+12) · corpus lint exit 0 con 4 warnings genuinos (eran 5; `w-abc` correctamente caído) · TDD 6-red → 94/94 green en structure/.