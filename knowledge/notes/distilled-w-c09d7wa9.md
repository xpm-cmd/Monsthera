---
id: k-4bb1ru11
title: Solution: findBySlug path-derivado: get por slug y collision-check de create fallan en archivos ID-named
slug: distilled-w-c09d7wa9
category: solution
tags: [consumer-driven, banyan, knowledge-repository, follow-up, distilled]
codeRefs: [src/knowledge/file-repository.ts, src/knowledge/service.ts]
references: [w-c09d7wa9]
createdAt: 2026-06-11T11:13:10.519Z
updatedAt: 2026-06-11T11:13:10.519Z
origin: distilled
distilled_from: w-c09d7wa9
---

> Distilled from work [w-c09d7wa9] on completion. Origin: `distilled`.

## Objective

Descubierto durante Wave A1 (write path). `FileSystemKnowledgeArticleRepository.findBySlug` lee `notes/<slug>.md` directo (path-derivado) en vez de buscar por frontmatter. Para corpora Option-A con archivos ID-named (Banyan):

1. **`getArticleBySlug` / `get_article(slug)` / `knowledge get <slug>`** → NotFound aunque el artículo exista (src/knowledge/service.ts:159).
2. **Collision-check de slug explícito en create** (src/knowledge/service.ts:97) → no ve la colisión con un artículo ID-named → permite DOS artículos con el mismo slug (unicidad de slug violada en silencio).

## Acceptance Criteria

- `findBySlug` resuelve artículos cuyo archivo no se llama `<slug>.md` (fallback a scan cuando el path directo es NotFound — mantener el fast-path actual para el caso slug-named).
- TDD: get-by-slug sobre fixture ID-named devuelve el artículo; create con slug explícito que colisiona con artículo ID-named devuelve AlreadyExists.
- Sin regresión en el comportamiento worktree-fallback de findBySlug.

## Code
- `src/knowledge/file-repository.ts`
- `src/knowledge/service.ts`
