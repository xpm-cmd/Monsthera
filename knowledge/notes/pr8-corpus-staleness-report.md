---
id: k-2jeulllv
title: PR-8: Consolidated corpus staleness report
slug: pr8-corpus-staleness-report
category: solution
tags: [m2, pr-8, structure, staleness, doctor, hygiene]
codeRefs: [src/structure/service.ts, src/tools/refs-tools.ts, src/cli/doctor-commands.ts, tests/unit/structure/staleness-report.test.ts]
references: []
createdAt: 2026-05-31T06:59:29.843Z
updatedAt: 2026-05-31T06:59:29.843Z
---

Second PR of M2. Folds per-item freshness into one whole-corpus, read-only staleness report.

## What shipped (main @ 2499368, PR #130)
- `StructureService.buildStalenessReport()` → `{ staleArticles, staleCodeRefs, sourceNewer, summary }`.
  - **staleArticles**: knowledge/work past the 45-day attention window, or (knowledge) whose linked source file is newer than the article. Sorted most-stale-first by `ageDays`.
  - **staleCodeRefs**: codeRefs that no longer resolve on disk (via the service's own `codeRefExists`).
  - **sourceNewer**: knowledge whose imported source changed after its last update (re-import candidates).
- Reuses `inspectKnowledgeArticle`/`inspectWorkArticle` from `src/context/insights.ts` — the SAME freshness logic `buildContextPack` applies per item — so the report can't drift.

## Surfaces
- MCP tool **`refs_stale`** in `src/tools/refs-tools.ts` (sibling of `refs_orphans`). Server already routes refs tool names through `handleRefsTool` — no `server.ts` change needed, only the definitions array + handler branch.
- `monsthera doctor` gains a "Corpus staleness (consolidated, read-only)" section (counts + top-5 sample). The pre-existing per-item "Stale code references" section (which feeds `--fix-stale-code-refs`) is untouched; the new one is additive.

## Gotchas / reusable facts
- In-memory repos accept `updatedAt`/`createdAt` on `create(...)` (knowledge: plain string; work: branded `timestamp(...)`), so stale articles are unit-testable without clock mocking.
- `inspectKnowledgeArticle` marks `freshness.state="stale"` when `sourceSyncState==="source-newer"` even for a young article — source-newer overrides age. Tests assert this override.
- `source-newer` fires when source mtime > article.updatedAt + 60s.

## Verification (hermetic)
pnpm test 2119 green (+9); typecheck/lint/corpus 0; `monsthera doctor` live smoke: 85 knowledge / 20 work scanned, 17 stale, 0 broken refs, exit 0.

Builds on [[pr7-context-pack-ranking-characterization]].