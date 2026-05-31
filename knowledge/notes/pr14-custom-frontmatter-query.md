---
id: k-v27p0qw2
title: PR-14a: Custom-frontmatter query filter (ADR-020 P2)
slug: pr14-custom-frontmatter-query
category: solution
tags: [m3, pr-14, custom-frontmatter, query, cli, mcp, adr-020]
codeRefs: [src/knowledge/custom-filter.ts, src/tools/knowledge-tools.ts, src/cli/knowledge-commands.ts, tests/unit/knowledge/custom-filter.test.ts]
references: [pr13-provenance]
createdAt: 2026-05-31T10:51:50.916Z
updatedAt: 2026-05-31T10:51:50.916Z
---

Closes **gap 2 of ADR-020**: custom frontmatter is now *queryable*. First of two small PRs splitting the handoff's PR-14 (the lint family, P3, is PR-14b — split to match M2 granularity, where a lint family shipped standalone in PR-9).

## What shipped (main @ e164435, PR #138)
- **`src/knowledge/custom-filter.ts`** (new, pure): `parseCustomFilter` + `matchesCustomFilter`.
  - `=` is **string equality** (stored scalar coerced via `String`); `<`, `<=`, `>`, `>=` are **numeric**.
  - **Leftmost-operator parsing**: scans left→right with two-char lookahead so `<=`/`>=` beat `<`/`>` and operators inside an equality value survive (`custom.note=a<b` → key `note`, value `a<b`).
  - **Scalars only**: objects/arrays are stored and returned verbatim but never match (ADR-012, no silent coercion).
- **MCP `list_articles`**: new `filter` param; malformed → `VALIDATION_FAILED`. In-memory layer atop the existing `tag`/`hasCodeRefs` filters (ADR-005) — no query language.
- **CLI `knowledge list`**: new `--filter` flag; malformed → stderr + exit 1.

## Deferred: the search-term-emission half (deliberate)
The handoff's other P2 half (emit `custom.<key>` *search* terms) is deferred. The tokenizer splits on every non-alphanumeric char (`/[^a-z0-9]+/` in `src/search/tokenizer.ts`), so a namespaced `custom.<key>` token can't survive without a riskier tokenizer change that could disturb the PR-7 ranking pins / `monsthera eval`. The exact `--filter` (tokenizer-independent) fully satisfies the acceptance and keeps PR-14a **eval-neutral** (verified: NDCG@5 1.0, MRR 1.0, P@5 0.2 unchanged). Revisit if fuzzy custom-field discovery is wanted.

## Downstream
PR-14b's `custom-frontmatter` lint reuses the same scalar-typing concepts; `origin` (from [[pr13-provenance]]) becomes filterable via `custom.origin=human`.

## Verification (hermetic)
`pnpm test` 2174 → 2189 (+15: custom-filter unit 12, list_articles filter integration 3); `typecheck`/`eslint`/`monsthera lint` corpus 0; CLI smoke confirms the filter is applied (collapses corpus to 0 on a non-matching filter).

Continues [[pr13-provenance]]. NEXT: PR-14b custom-frontmatter lint (ADR-020 P3), PR-15 git/PR ingestion.