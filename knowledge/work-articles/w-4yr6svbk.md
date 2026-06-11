---
id: w-4yr6svbk
title: H4 — Cerrar los drops silenciosos de la capa de tools MCP (knowledge + work)
template: bugfix
phase: implementation
priority: high
author: claude-code
tags: [wave-h, mcp-tools, api-hygiene, silent-failure]
references: []
codeRefs: [src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/knowledge/service.ts, src/work/service.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T12:23:36.560Z
updatedAt: 2026-06-11T12:46:05.835Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"claude-code","status":"contributed","contributedAt":"2026-06-11T12:45:58.508Z"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T12:23:36.560Z","exitedAt":"2026-06-11T12:45:52.685Z"},{"phase":"enrichment","enteredAt":"2026-06-11T12:45:52.685Z","metadata":{"branch":"fix/h4-tool-silent-drops","sweep":"workflow 3 agentes: knowledge-chain / work-chain / cli-parity"},"exitedAt":"2026-06-11T12:46:05.835Z"},{"phase":"implementation","enteredAt":"2026-06-11T12:46:05.835Z","metadata":{"tdd":"24 pins RED verificado + 2 CLI reds + 2 pins viejos volteados conscientemente","new_bug_found":"rename real descartaba extraFrontmatter/sourcePath (WriteWithSlugInput sin campos)"}}]}
---

## Objective

Caso conocido: el tool MCP `update_article` ignora `sourcePath` en silencio — el repo SÍ lo soporta (`UpdateKnowledgeArticleInput.sourcePath` existe y `update()` lo aplica); el gap está en schema/tool. Sweep sistemático: diffear los schemas de los tools MCP (`create_article`, `update_article`, `batch_*`, `create_work`, `update_work`) contra los inputs que service/repo aceptan, en AMBAS direcciones: campo aceptado por el repo y no expuesto (gap de capability) vs campo que un caller puede mandar y se dropea sin error (bug de silencio).

## Acceptance Criteria

- Tabla de gaps en el PR con veredicto por campo: **exponer con validación, o rechazar con ValidationError explícito. Nunca silencio.**
- TDD por gap cerrado (red→green real).
- Cero drops silenciosos restantes en tools de knowledge + work.
- CLI parity donde aplique (T4 ya igualó tags).
- Gates estándar: typecheck 0 · eslint 0 · coverage exit 0 · corpus lint 0 · audit high 0. No toca ranking → eval gate no aplica (verificación: cero cambios en src/search y src/eval).