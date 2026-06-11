---
id: k-e60cayja
title: Wave E3: structure/service.ts — citation-analyzer, staleness, code-ref-indexer y tag-edge-builder extraídos (1337 → 874)
slug: wave-e3-structureservicets-citation-analyzer-staleness-code-ref-indexer-y-tag-edge-builder-extrados-1337-874
category: solution
tags: [wave-e, refactor, file-split, structure, citation-analyzer]
codeRefs: [src/structure/service.ts, src/structure/citation-analyzer.ts, src/structure/code-ref-indexer.ts, src/structure/tag-edge-builder.ts, src/structure/staleness-report.ts]
references: [k-bhj6atny, k-3zo9w9dg]
createdAt: 2026-06-11T00:48:49.513Z
updatedAt: 2026-06-11T00:48:49.513Z
---

Rama `refactor/e3-structure-modules` desde main post-#167. Cuarto split del backlog.

## Diseño

`service.ts` 1337→874. Patrón: **funciones puras con inputs explícitos** (arrays de artículos, repoPath); los métodos de la clase quedan como orquestadores delgados (repo I/O + `ok()`). Cuatro módulos: citation-analyzer (355: orphans + cited-values + contradictions con sus helpers) · code-ref-indexer (119: `codeRefExists` con repoPath explícito, owner index, `assembleCodeGraphNodes`) · tag-edge-builder (103: ensamblaje 3-tier de shared_tag + constantes de umbral) · staleness-report (95). Los tipos exportados se quedan en service.ts (10+ consumidores los importan de service.js); los módulos hacen type-import de vuelta (erased, sin ciclo runtime).

## Lo que NO se extrajo — y por qué eso es lo correcto

El assembly de nodos knowledge/work + edges reference/dependency de `getGraph` comparte estado de closures (mapas byId/BySlug, sets de missing, addNode/addEdge): extraerlo habría enhebrado medio método por parámetros. **Forzar una extracción que empeora el acoplamiento es peor que un archivo largo** — quedó en service.ts con la razón documentada. getNeighbors/getGraphSummary/getRefGraph no descomponen naturalmente. La equivalencia byte-a-byte del orden de nodos/edges se preservó re-añadiendo las colecciones de los módulos en los puntos de inserción originales exactos (el merge de shared_tag es self-contained porque los ids `shared_tag:` no colisionan con otros kinds).

## Follow-up identificado por el agente

`src/cli/doctor-commands.ts:141` tiene una copia local idéntica de `codeRefExists` — dedupe contra el ahora-exportado (post-merge, fuera de este diff cero-cambio).

## Verificación

564 tests structure/tools/dashboard sin tocar · coverage de los módulos nuevos visible (89-97% salvo tag-edge-builder 70%) · gate completo (typecheck 0 · eslint 0 · coverage exit 0 con 2322 · corpus lint 0 · audit high 0).