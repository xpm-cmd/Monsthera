---
id: k-5gwkhix1
title: P2: Per-category staleness windows in insights.ts
slug: p2-per-category-staleness-windows-in-insightsts
category: decision
tags: [p2, staleness, insights, freshness, corpus-hygiene, decision, verified, shipped]
codeRefs: [src/context/insights.ts, src/structure/service.ts, tests/unit/context/insights-thresholds.test.ts]
references: [k-2jeulllv, k-gtgddgs3]
createdAt: 2026-06-10T09:11:40.323Z
updatedAt: 2026-06-10T09:13:36.973Z
---

## Problem
The 2026-06-10 audit flagged 63 of 114 articles "stale". Staleness used a SINGLE window — `freshnessFromAge(ageDays, freshDays=14, staleDays=45)` at `src/context/insights.ts:73`. An ADR / architecture decision does not rot on the same 45-day clock as a handoff or context note, so the single window floods the report with noise and trains people to ignore it.

## Decision (lighter fix; verified_at frontmatter field rejected as heavier)
Resolve the freshness window from `article.category` inside `inspectKnowledgeArticle`, falling through to the existing 14/45 default. Explicit `opts.{freshDays,staleDays}` still WIN when passed.

### Category -> window map (knowledge only)
- **durable** `decision | architecture | adr | guide | reference` -> fresh 90 / stale 180
- **semi-durable** `pattern | solution | gotcha` -> fresh 30 / stale 90
- **ephemeral / default** `context | handoff` and everything else -> fresh 14 / stale 45 (UNCHANGED — preserves back-compat for the common case)

Resolution is case-insensitive (`category.toLowerCase()`); unknown categories fall through to the 14/45 default. Rationale: ADRs/architecture are reviewed on a quarterly-ish cadence; patterns/solutions drift faster as code evolves but slower than a handoff; context/handoff are session-scoped and SHOULD rot fast.

## Precedence (critical), implemented per-field
1. Explicit `opts.freshDays`/`opts.staleDays` (each independently) — highest. `SearchService` (build_context_pack) ALWAYS passes config 14/45, so context-pack keeps single-window behavior — back-compat preserved exactly.
2. Category map (knowledge only) — applied for whichever field opts omits.
3. Hard default 14/45 (via `freshnessWindowForCategory` returning DEFAULT for unknown categories).

A caller may override only `freshDays` and still inherit the category-resolved `staleDays` (tested).

## refs_stale + doctor SHARE it (no divergent definition)
`StructureService.buildStalenessReport()` (`src/structure/service.ts:927,957`) calls `inspectKnowledgeArticle(article, { repoPath })` / `inspectWorkArticle(article)` with NO fresh/stale override. Category resolution lives INSIDE `inspectKnowledgeArticle`, so `refs_stale` (MCP) and `monsthera doctor` — the exact surfaces the audit complained about — pick up the category-aware window for free. One staleness definition, zero threading.

## Scope notes
- Work articles have NO `category` field (only `template`) — confirmed in `src/work/repository.ts`. `inspectWorkArticle` keeps the flat 14/45 default; handoffs/work stay short-window, matching intended policy.
- NO new frontmatter field, NO write-path change (verified_at was the rejected heavier alternative).

## VERIFIED (shipped, feat/p2-corpus-hygiene)
- `tests/unit/context/insights-thresholds.test.ts`: 13 pass (8 pre-existing PR-10 back-compat + 5 new category groups, TDD red->green).
- `tests/unit/structure/staleness-report.test.ts`: untouched + still green (all fixtures are `category:"context"` -> unchanged 14/45, so the parallel structure agent's assertions are unaffected). Combined context+structure run: 43/43 green.
- `tsc --noEmit` 0, `eslint` 0 on touched files.
- **Live `monsthera doctor --scope all` (current source via tsx): stale articles 63 -> 43** (knowledge 35, work 8). The 20-article drop is entirely durable categories (ADR/architecture/decision/guide/reference/pattern); remaining knowledge stale are genuinely ephemeral `context` notes (e.g. dashboard notes @ 60d, correctly still stale). 0 broken code refs, exit 0.

## Files
- `src/context/insights.ts` — `DEFAULT_FRESHNESS_WINDOW`, `FRESHNESS_WINDOW_BY_CATEGORY`, `freshnessWindowForCategory()`, per-field resolution in `inspectKnowledgeArticle`.
- `tests/unit/context/insights-thresholds.test.ts` — category cases + case-insensitivity + partial-override + explicit-override-wins.