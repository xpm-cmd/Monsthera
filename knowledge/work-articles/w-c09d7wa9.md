---
id: w-c09d7wa9
title: findBySlug path-derivado: get por slug y collision-check de create fallan en archivos ID-named
template: bugfix
phase: done
priority: medium
author: claude-code
tags: [consumer-driven, banyan, knowledge-repository, follow-up]
references: [k-zv7qfvll]
codeRefs: [src/knowledge/file-repository.ts, src/knowledge/service.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T11:36:09.607Z
updatedAt: 2026-06-11T11:13:10.365Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T11:36:09.607Z","exitedAt":"2026-06-11T11:04:58.175Z"},{"phase":"enrichment","enteredAt":"2026-06-11T11:04:58.175Z","exitedAt":"2026-06-11T11:05:34.508Z"},{"phase":"implementation","enteredAt":"2026-06-11T11:05:34.508Z","exitedAt":"2026-06-11T11:13:02.003Z","reason":"Solo-agent session: el rol testing pendiente se cumple inline con TDD red→green (tests son parte del AC y del gate del PR).","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-06-11T11:13:02.003Z","reason":"Solo-agent merge-as-you-go: review = gate completo del PR (typecheck/eslint/coverage 2345/corpus-lint/audit todos 0) + CI verde de GitHub (1m52s) + aceptación en clon Banyan.","skippedGuards":["implementation_linked"],"metadata":{"pr":174,"merged_sha":"f7c7ec4","success_test":"knowledge get scope-seed resuelve k-00-scope-seed en clon Banyan (antes NotFound); 4 red→green TDD","suite":"2340→2345"},"exitedAt":"2026-06-11T11:13:10.365Z"},{"phase":"done","enteredAt":"2026-06-11T11:13:10.365Z","reason":"Sin reviewer humano asignado en sesión solo-agent; evidencia de cierre: PR #174 mergeado a main (f7c7ec4), nota solution k-p90ik5jo, aceptación Banyan documentada.","skippedGuards":["all_reviewers_approved"],"metadata":{"pr":174,"merged_sha":"f7c7ec4","solution_note":"k-p90ik5jo"}}]}
completedAt: 2026-06-11T11:13:10.365Z
---

## Objective

Descubierto durante Wave A1 (write path). `FileSystemKnowledgeArticleRepository.findBySlug` lee `notes/<slug>.md` directo (path-derivado) en vez de buscar por frontmatter. Para corpora Option-A con archivos ID-named (Banyan):

1. **`getArticleBySlug` / `get_article(slug)` / `knowledge get <slug>`** → NotFound aunque el artículo exista (src/knowledge/service.ts:159).
2. **Collision-check de slug explícito en create** (src/knowledge/service.ts:97) → no ve la colisión con un artículo ID-named → permite DOS artículos con el mismo slug (unicidad de slug violada en silencio).

## Acceptance Criteria

- `findBySlug` resuelve artículos cuyo archivo no se llama `<slug>.md` (fallback a scan cuando el path directo es NotFound — mantener el fast-path actual para el caso slug-named).
- TDD: get-by-slug sobre fixture ID-named devuelve el artículo; create con slug explícito que colisiona con artículo ID-named devuelve AlreadyExists.
- Sin regresión en el comportamiento worktree-fallback de findBySlug.