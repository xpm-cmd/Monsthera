---
id: k-dpdrql19
title: PR P2 shipped — corpus & lint hygiene (ADR import, orphan FP fix, staleness por categoría)
slug: pr-p2-shipped-corpus-lint-hygiene-adr-import-orphan-fp-fix-staleness-por-categora
category: solution
tags: [audit, corpus-hygiene, lint, staleness, wave-3, post-m3]
codeRefs: [src/structure/service.ts, src/structure/wikilink.ts, src/context/insights.ts, tests/unit/structure/orphan-citations.test.ts, tests/unit/context/insights-thresholds.test.ts]
references: [k-3zo9w9dg]
createdAt: 2026-06-10T09:21:04.884Z
updatedAt: 2026-06-10T09:21:04.884Z
---

Wave 3 de la auditoría 2026-06-10 (ver [[auditora-integral-2026-06-10-backlog-priorizado-post-m3]]). Rama `feat/p2-corpus-hygiene`. Tres frentes, un PR.

## 1. Import de los 15 ADRs faltantes (orphans 24 → 13)

`ingest local --path docs/adrs/NNN-*.md --category architecture --no-imported-tag` por archivo. **Gotcha clave:** el slug se deriva del TÍTULO completo del documento, no del filename — 6 ADRs con títulos descriptivos largos generaron slugs divergentes de los que citan las notas (p.ej. `adr-009-convoys-requires-as-hard-block-and-mid-session-resync` vs el citado `adr-009-convoys-requires-resync`). Esos imports NO resolvieron sus orphans hasta renombrar con `update_article(id, new_slug=...)`, que renombra el .md y reescribe referencias entrantes atómicamente. Lección: tras importar un doc cuyo slug debe coincidir con citas existentes, verificar el slug resultante — el título manda, no el filename.

## 2. Falsos positivos de orphan_citation (13 → 5)

Fix en el productor compartido `StructureService.getGraph()` (las tres superficies — `monsthera lint`, `knowledge refs --orphans`, tool MCP `refs_orphans` — convergen ahí):
- **URLs** (`/^https?:\/\//i`) ya no entran a `missingReferences` (no inflan `missingReferenceCount`; una URL nunca resuelve a un nodo k-/w-).
- **Inline-code multilínea**: `stripCodeRegions` ahora cubre spans de backtick que cruzan newline (los `w-a`/`w-b`/`w-x` de convoy-hardening soft-wrapeados). Los fenced blocks ya estaban cubiertos desde ADR-010.
- Control intacto: refs genuinamente faltantes siguen flageando. Los 5 orphans restantes son reales (placeholders `w-abc`/`k-abc123` en prosa, 2 refs colgantes de roadmap, 1 cross-ref de handoff hermano).

## 3. Staleness por categoría (63 → 43 stale)

`freshnessWindowForCategory()` en `src/context/insights.ts`: durables (decision/architecture/adr/guide/reference) → 90/180; semi-durables (pattern/solution/gotcha) → 30/90; ephemeral/default (context/handoff/resto) → 14/45 sin cambio (back-compat exacta del caso común). `opts.freshDays`/`opts.staleDays` explícitos siguen ganando por campo. La caída de 20 artículos viene íntegramente de categorías durables — era exactamente el ruido que entrenaba a ignorar el reporte.

## Verificación (real)

typecheck 0 · eslint 0 · coverage EXIT 0 (lines 72.63 / branches 61.33 / functions 81.73) · **2251 passed | 3 skipped** · corpus lint exit 0 con 5 warnings genuinos · knowledgeCount 114.

## Diferido consciente

Rename del ADR-014 duplicado (convoy-dashboard vs portable-workspace-operations, ambos importados con slugs distintos — el número duplicado es cosmético y cross-ref-delicado); `k-abc123` del mcp-tool-catalog (mención en prosa desnuda, fixable corpus-side con backticks).