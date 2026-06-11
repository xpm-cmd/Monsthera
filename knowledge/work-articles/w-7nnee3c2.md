---
id: w-7nnee3c2
title: Work file-repository: adoptar StatCachedDirectoryReader en los métodos de filtro
template: refactor
phase: planning
priority: low
author: claude-code
tags: [wave-h, performance, repository, cache, follow-up]
references: []
codeRefs: [src/work/file-repository.ts, src/core/stat-cache.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T12:18:55.716Z
updatedAt: 2026-06-11T12:18:55.716Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T12:18:55.716Z"}]}
---

## Objective

H1 (w-n75fifq1) introdujo `StatCachedDirectoryReader` y lo cableó solo en el knowledge file-repository. El work repo NO comparte el patrón agresivo (findById/exists usan acceso directo a archivo), pero sus ~7 métodos de filtro (findByPhase, findByAssignee, findByTag, list, etc.) sí re-parsean `knowledge/work-articles/` completo por llamada. A ~32 archivos es irrelevante; si el volumen de work articles crece (multi-agente, convoys), adoptar el reader compartido.

Se registró como follow-up y no se incluyó en H1 porque el fix no era compartible barato: la invalidación debe coordinarse con los 3 write-paths bajo `withFileLock` del work repo y con `delete()` que re-lee el corpus para actualizar dependientes (línea ~328).

## Acceptance Criteria

- Métodos de filtro del work repo van por `StatCachedDirectoryReader` (mismo helper de core, sin fork).
- Invalidación tras writes propios dentro de los scopes de `withFileLock` existentes y en `delete()` (incluyendo la pasada de dependientes).
- Semántica externa intacta: escrituras directas al dir detectadas (stat sweep), cero fantasmas, errores no cacheados.
- TDD: test conductor de no-re-lectura + pins de visibilidad (mismo patrón que tests/unit/knowledge/file-repository-cache.test.ts).
- Suite completa verde + eval gate idéntico a 4 decimales (refactor de read-path).