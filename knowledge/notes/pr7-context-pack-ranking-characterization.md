---
id: k-174l945h
title: PR-7: Context-pack ranking characterization pin
slug: pr7-context-pack-ranking-characterization
category: solution
tags: [m2, pr-7, search, ranking, characterization, testing]
codeRefs: [src/search/service.ts, tests/unit/search/context-pack-ranking.test.ts]
references: []
createdAt: 2026-05-31T06:46:25.341Z
updatedAt: 2026-05-31T06:46:25.341Z
---

First PR of M2 (knowledge-capability plan). Locks the context-pack ranking formula in place before PR-10 (config knobs) and PR-11 (reranker) mutate it.

## What shipped (main @ 534e341, PR #129)
- Exported the previously-private pure helper `scoreContextPackItem` from `src/search/service.ts`.
- Added `tests/unit/search/context-pack-ranking.test.ts` — 20 cases pinning **exact** scores across every branch of the formula.

## The pinned formula (defaults, no config yet)
```
total  = baseScore + qualityScore/40 + freshness{fresh:+0.5, attention:+0.2, unknown:+0.1, stale:-0.25}
code:      + min(1.2, codeRefCount*0.35) + 0.4(knowledge cat∈{architecture,engineering,solution,runbook}) + 0.35(work tmpl∈{feature,bugfix,refactor}) + 0.2(phase∈{implementation,review})
research:  + min(0.8, referenceCount*0.2) + 0.5(sourcePath) + 0.4(knowledge cat∈{guide,context,solution,runbook,research}) + 0.8(tmpl==spike) + 0.2(phase∈{planning,enrichment})
result = Number(total.toFixed(3))
```
Mode bonuses apply ONLY in their mode; general mode ignores code/research fields.

## Guidance for later PRs
- **PR-10** makes BM25 K1/title-boost, freshness 14/45 thresholds, and these mode weights config-driven. When defaults change behavior, update these pins on purpose — a broken fixture is the intended signal. Defaults must keep the suite green.
- **PR-11** reranker stage sits in `SearchService.search()`; it must not alter `scoreContextPackItem` defaults (stub = identical scores).

## Scope decision (deviation from the handoff, on purpose)
The handoff also listed rename+wikilink and `verifyCitedValues` pins. Those already exist and are comprehensive — `tests/unit/knowledge/slug-rename.test.ts` (incl. atomic staged-write rollback + `[[slug]]` rewrite) and `tests/unit/structure/verify-cited-values.test.ts`. No duplication added; the genuine gap was the ranking scorer. PR-9's protection for `verifyCitedValues` therefore already exists.

## Verification (hermetic: MONSTHERA_DOLT_ENABLED=false MONSTHERA_SEMANTIC_ENABLED=false)
pnpm test → 2110 passed / 160 files (+20 tests, +1 file); typecheck 0; lint 0; corpus lint 0.