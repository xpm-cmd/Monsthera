---
id: w-4yr6svbk
title: H4 — Cerrar los drops silenciosos de la capa de tools MCP (knowledge + work)
template: bugfix
phase: done
priority: high
author: claude-code
tags: [wave-h, mcp-tools, api-hygiene, silent-failure]
references: []
codeRefs: [src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/knowledge/service.ts, src/work/service.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T12:23:36.560Z
updatedAt: 2026-06-11T12:49:21.016Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"claude-code","status":"contributed","contributedAt":"2026-06-11T12:45:58.508Z"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T12:23:36.560Z","exitedAt":"2026-06-11T12:45:52.685Z"},{"phase":"enrichment","enteredAt":"2026-06-11T12:45:52.685Z","exitedAt":"2026-06-11T12:46:05.835Z","metadata":{"branch":"fix/h4-tool-silent-drops","sweep":"workflow 3 agentes: knowledge-chain / work-chain / cli-parity"}},{"phase":"implementation","enteredAt":"2026-06-11T12:46:05.835Z","exitedAt":"2026-06-11T12:49:11.427Z","metadata":{"tdd":"24 pins RED verificado + 2 CLI reds + 2 pins viejos volteados conscientemente","new_bug_found":"rename real descartaba extraFrontmatter/sourcePath (WriteWithSlugInput sin campos)"}},{"phase":"review","enteredAt":"2026-06-11T12:49:11.427Z","reason":"Sesión single-agent merge-as-you-go: revisión real = CI verde (typecheck/lint/test/corpus 1m33s) + 24 pins TDD en RED verificado + sweep multi-agente previo; sin reviewer humano asignable.","skippedGuards":["implementation_linked"],"metadata":{"pr":179,"ci":"pass 1m33s"},"exitedAt":"2026-06-11T12:49:21.016Z"},{"phase":"done","enteredAt":"2026-06-11T12:49:21.016Z","reason":"Review gate cubierto por CI verde + 26 tests nuevos (24 pins + 2 CLI) con RED verificado + matriz de veredictos completa en el PR; sin reviewer humano en flujo single-agent merge-as-you-go.","skippedGuards":["all_reviewers_approved"],"metadata":{"pr":179,"merged_sha":"7ea631e","nota":"k-2e0b09bj","suite":"2366→2392","highlights":"strict schemas ×4, sourcePath end-to-end, rename drop fix, tag deltas al service, create_work deps advertised"}}]}
completedAt: 2026-06-11T12:49:21.016Z
---

## Objective

Caso conocido: el tool MCP `update_article` ignora `sourcePath` en silencio — el repo SÍ lo soporta (`UpdateKnowledgeArticleInput.sourcePath` existe y `update()` lo aplica); el gap está en schema/tool. Sweep sistemático: diffear los schemas de los tools MCP (`create_article`, `update_article`, `batch_*`, `create_work`, `update_work`) contra los inputs que service/repo aceptan, en AMBAS direcciones: campo aceptado por el repo y no expuesto (gap de capability) vs campo que un caller puede mandar y se dropea sin error (bug de silencio).

## Acceptance Criteria

- Tabla de gaps en el PR con veredicto por campo: **exponer con validación, o rechazar con ValidationError explícito. Nunca silencio.**
- TDD por gap cerrado (red→green real).
- Cero drops silenciosos restantes en tools de knowledge + work.
- CLI parity donde aplique (T4 ya igualó tags).
- Gates estándar: typecheck 0 · eslint 0 · coverage exit 0 · corpus lint 0 · audit high 0. No toca ranking → eval gate no aplica (verificación: cero cambios en src/search y src/eval).