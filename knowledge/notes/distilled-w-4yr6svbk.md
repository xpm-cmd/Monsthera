---
id: k-84hmqyez
title: Solution: H4 — Cerrar los drops silenciosos de la capa de tools MCP (knowledge + work)
slug: distilled-w-4yr6svbk
category: solution
tags: [wave-h, mcp-tools, api-hygiene, silent-failure, distilled]
codeRefs: [src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/knowledge/service.ts, src/work/service.ts]
references: [w-4yr6svbk]
createdAt: 2026-06-11T12:49:21.214Z
updatedAt: 2026-06-11T12:49:21.214Z
origin: distilled
distilled_from: w-4yr6svbk
---

> Distilled from work [w-4yr6svbk] on completion. Origin: `distilled`.

## Objective

Caso conocido: el tool MCP `update_article` ignora `sourcePath` en silencio — el repo SÍ lo soporta (`UpdateKnowledgeArticleInput.sourcePath` existe y `update()` lo aplica); el gap está en schema/tool. Sweep sistemático: diffear los schemas de los tools MCP (`create_article`, `update_article`, `batch_*`, `create_work`, `update_work`) contra los inputs que service/repo aceptan, en AMBAS direcciones: campo aceptado por el repo y no expuesto (gap de capability) vs campo que un caller puede mandar y se dropea sin error (bug de silencio).

## Acceptance Criteria

- Tabla de gaps en el PR con veredicto por campo: **exponer con validación, o rechazar con ValidationError explícito. Nunca silencio.**
- TDD por gap cerrado (red→green real).
- Cero drops silenciosos restantes en tools de knowledge + work.
- CLI parity donde aplique (T4 ya igualó tags).
- Gates estándar: typecheck 0 · eslint 0 · coverage exit 0 · corpus lint 0 · audit high 0. No toca ranking → eval gate no aplica (verificación: cero cambios en src/search y src/eval).

## Code
- `src/tools/knowledge-tools.ts`
- `src/tools/work-tools.ts`
- `src/knowledge/service.ts`
- `src/work/service.ts`
