---
id: w-c09d7wa9
title: findBySlug path-derivado: get por slug y collision-check de create fallan en archivos ID-named
template: bugfix
phase: implementation
priority: medium
author: claude-code
tags: [consumer-driven, banyan, knowledge-repository, follow-up]
references: [k-zv7qfvll]
codeRefs: [src/knowledge/file-repository.ts, src/knowledge/service.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T11:36:09.607Z
updatedAt: 2026-06-11T11:05:34.508Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T11:36:09.607Z","exitedAt":"2026-06-11T11:04:58.175Z"},{"phase":"enrichment","enteredAt":"2026-06-11T11:04:58.175Z","exitedAt":"2026-06-11T11:05:34.508Z"},{"phase":"implementation","enteredAt":"2026-06-11T11:05:34.508Z","reason":"Solo-agent session: el rol testing pendiente se cumple inline con TDD red→green (tests son parte del AC y del gate del PR).","skippedGuards":["min_enrichment_met"]}]}
---

## Objective

Descubierto durante Wave A1 (write path). `FileSystemKnowledgeArticleRepository.findBySlug` lee `notes/<slug>.md` directo (path-derivado) en vez de buscar por frontmatter. Para corpora Option-A con archivos ID-named (Banyan):

1. **`getArticleBySlug` / `get_article(slug)` / `knowledge get <slug>`** → NotFound aunque el artículo exista (src/knowledge/service.ts:159).
2. **Collision-check de slug explícito en create** (src/knowledge/service.ts:97) → no ve la colisión con un artículo ID-named → permite DOS artículos con el mismo slug (unicidad de slug violada en silencio).

## Acceptance Criteria

- `findBySlug` resuelve artículos cuyo archivo no se llama `<slug>.md` (fallback a scan cuando el path directo es NotFound — mantener el fast-path actual para el caso slug-named).
- TDD: get-by-slug sobre fixture ID-named devuelve el artículo; create con slug explícito que colisiona con artículo ID-named devuelve AlreadyExists.
- Sin regresión en el comportamiento worktree-fallback de findBySlug.