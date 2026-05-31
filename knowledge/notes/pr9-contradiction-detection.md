---
id: k-s07gu3dm
title: PR-9: Deterministic cross-article contradiction detection
slug: pr9-contradiction-detection
category: solution
tags: [m2, pr-9, structure, contradictions, lint, think, hygiene]
codeRefs: [src/structure/service.ts, src/work/guards.ts, src/work/lint.ts, src/cli/lint-commands.ts, src/search/think-synthesis.ts, src/search/service.ts]
references: []
createdAt: 2026-05-31T07:22:25.713Z
updatedAt: 2026-05-31T07:22:25.713Z
---

Third PR of M2. Surfaces when two corpus articles disagree on the same canonical quantity, and feeds that into `think`.

## What shipped (main @ 6676975, PR #131)
- `StructureService.detectContradictions(canonicalValues, opts?)` → `ContradictionFinding[]`: graph-adjacent articles (sharing a normalized tag or code ref) that state DIFFERENT values for the same canonical name. Deterministic. Article ids ordered (`articleA < articleB`) so a pair surfaces once. `opts.articleId` (id or slug) restricts to pairs involving that article.
- Reuses canonical-value extraction: factored `extractStatedCanonicalValues` + exported `normaliseCanonicalNumber` out of `src/work/guards.ts`, and refactored `getCanonicalValueViolations` to call it (behavior preserved — existing canonical tests green).

## Wiring (followed the existing "compute-in-service, merge-in-scanner" seam)
- **lint**: new `contradictions` registry family (severity **warning**, never gates exit code). `ContradictionLintFinding` added to the `LintFinding` union; `contradictionFindings?` added to `LintScanInput`; `scanCorpus` merges it gated by `runContradictions`. CLI `monsthera lint --registry contradictions` computes via `collectContradictionFindings` (mirrors `--with-citation-values`). Mirrors how orphan/citation findings are computed in StructureService and merged in.
- **think**: `deriveContradictionGaps(items, contents, canonicalValues)` (pure, in `think-synthesis.ts`) emits deterministic `contradictory` gaps among co-retrieved pack items — no adjacency filter there (retrieval already relates them). Wired into BOTH the degraded and LLM paths of `SearchService.think`. `SearchService.loadCanonicalValues()` self-loads the registry via `PolicyLoader`, degrade-safe (any failure → empty registry → no gaps, think never fails).
- **doctor**: read-only "Cross-article contradictions" section.

## Scope decision
**LLM tier DEFERRED** (handoff marked it optional). This deterministic tier meets both acceptance criteria (lint reports a pair; think populates `contradictory`). The LLM tier would build on `detectContradictions` over graph-adjacent pairs via `container.textGenerator`, degrade-safe.

## Gotchas / reusable facts
- `normaliseNumericToken` (guards) does NOT collapse trailing zeros: "0.010" vs "0.01" are treated as DIFFERENT (intentional drift detection). Contradiction detection inherits this.
- `scanCorpus` merges `orphanFindings`/`citationValueFindings` UNCONDITIONALLY (not registry-gated); I gated contradictions with `runContradictions` so `--registry contradictions` doesn't leak from other families (though orphans still always show — pre-existing).
- SearchService already imports from `work/`, so importing `PolicyLoader`/`guards` there is consistent layering (no cycle: policy-loader doesn't import search).
- The canonical registry supplies only the VOCABULARY of names to check; comparison is article-vs-article, so the registry's `value` is not the arbiter.

## Verification (hermetic)
pnpm test 2133 green (+14); typecheck/eslint/corpus 0; `lint --registry contradictions` + `doctor` smoke exit 0 (0 findings on live corpus — no canonical-values policy present).

Builds on [[pr8-corpus-staleness-report]] and [[pr7-context-pack-ranking-characterization]].