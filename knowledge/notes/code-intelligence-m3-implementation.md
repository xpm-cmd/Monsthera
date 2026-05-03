---
id: k-code-intel-m3-impl
title: Code Intelligence M3 Implementation
slug: code-intelligence-m3-implementation
category: implementation
tags: [code-intelligence, code-inventory, mcp-tools, cli, implementation, m3, adr-017, textmate]
codeRefs: [src/code-intelligence/inventory/types.ts, src/code-intelligence/inventory/extractor.ts, src/code-intelligence/inventory/service.ts, src/code-intelligence/inventory/persistence.ts, src/code-intelligence/inventory/language-map.ts, src/code-intelligence/inventory/index.ts, src/code-intelligence/service.ts, src/tools/code-query-tool.ts, src/cli/code-commands.ts, src/core/container.ts, src/core/status.ts, src/server.ts, src/search/service.ts, src/persistence/schema.ts, tests/fixtures/code-intelligence/m3, tests/unit/code-intelligence/inventory/extractor.test.ts, tests/unit/code-intelligence/inventory/service.test.ts, tests/unit/code-intelligence/inventory/persistence.test.ts, tests/unit/code-intelligence/service.phase4.test.ts, tests/unit/search/service.phase4-breadcrumb.test.ts, tests/unit/tools/code-query-tool.test.ts, knowledge/notes/monsthera-cli-command-cheatsheet.md, docs/adrs/015-code-intelligence-strategy.md, docs/adrs/017-code-intelligence-m3-lightweight-inventory.md]
references: [adr-015-code-intelligence-strategy, adr-017-code-intelligence-m3-lightweight-inventory, code-ref-intelligence-mvp-implementation, code-ref-intelligence-m2-implementation]
createdAt: 2026-05-03T00:00:00.000Z
updatedAt: 2026-05-03T00:00:00.000Z
---

## Summary

Shipped Milestone 3 of ADR-015 — a lightweight, multi-language symbol-and-file
inventory derived under `.monsthera/cache/code-index.json`, exposed through a
new `code_query` MCP tool, two new CLI subcommands (`monsthera code query` and
`monsthera code reindex`), a one-line breadcrumb in
`build_context_pack(mode="code")`, and two new conservative `reasons` codes
(`file_has_no_exports`, `file_is_manifest`) on the existing M1/M2 risk
surfaces. Delivered across five branched PRs (#96 plan, #97 phase 1, #98 phase
2, #99 phase 3, #100 phase 4, plus this docs PR) per the routine-driven cascade
that ADR-017 locked in.

Implementation honours the architectural constraints from ADR-014/015/017:
JSON-canonical persistence with optional Dolt mirror, no native dependencies,
`Result<T, E>` at the domain boundary, MCP server never shells out, and exact-
pinned new deps. M1/M2 APIs (`code_get_ref`, `code_find_owners`,
`code_analyze_impact`, `code_detect_changes`) keep their payload shape — only
the `reasons` arrays gain new entries.

## Added

### Phase 1 — TextMate extractor (PR #97)

- Exact-pinned runtime deps in `package.json`: `vscode-textmate@9.3.2`,
  `vscode-oniguruma@2.0.1`, `@shikijs/langs@4.0.2`. No native bindings; pure
  JS + WASM.
- `TextMateSymbolExtractor` in `src/code-intelligence/inventory/extractor.ts`
  implementing the `SymbolExtractor` contract scaffolded earlier in the
  planning PR. Token filter per ADR-017 §D2:
  `entity.name.function.*` and `entity.name.type.{class,interface,alias,enum,namespace,module,record}.*`
  scopes, with `entity.name.function.call.*` excluded to keep call sites out
  of the symbol set.
- `language-map.ts` — extension → grammar dispatch. Lazy ESM import from
  `@shikijs/langs/<lang>`; a Python parse never loads the Rust grammar.
- Per-language fixtures under `tests/fixtures/code-intelligence/m3/` for
  TypeScript, TSX, JavaScript, Python, Go, Rust, Ruby, Markdown, and
  `unknown.fix.xyz` (degraded path).

### Phase 2 — service & persistence (PR #98)

- `CodeInventoryService` in `src/code-intelligence/inventory/service.ts` with
  `build`, `query`, `getStatus`, `reindex({ full? })`, and
  `getSymbolsForFile`.
- `JsonInventoryPersistence` in `persistence.ts` — JSON read/write at
  `.monsthera/cache/code-index.json` using `proper-lockfile`, plus optional
  Dolt mirror behind a `null doltClient` short-circuit.
- Lazy mtime-per-file invalidation: `query` and `getSymbolsForFile` compare
  recorded `mtimeMs` against `fs.statSync(path).mtimeMs`; mismatches re-extract
  in memory and debounced-flush to disk.
- `code_artifacts` and `code_relations` Dolt tables registered in
  `src/persistence/schema.ts` with conservative column types
  (varchar(255) for ids/names, text for paths, int for line numbers).
- File-walk policy applied at the CLI boundary (not inside the service): skip
  symlinks, skip files >1 MB, skip files whose first 4 KB contains a null
  byte (binary detection).

### Phase 3 — MCP tool & CLI surfaces (PR #99)

- `code_query` MCP tool in `src/tools/code-query-tool.ts` with Zod schema
  `{ query (≥2 chars), kinds?, paths?, languages?, limit? (1-500, default 50) }`.
  Registered alongside the four existing `code_*` tools in `src/server.ts`.
- `monsthera code query <text> [--kinds] [--paths] [--languages] [--limit]`
  in `src/cli/code-commands.ts` — JSON-only on stdout, errors to stderr,
  non-zero exit on error.
- `monsthera code reindex [--full]` — shells `git ls-files` to get the file
  list, feeds it to `service.build()`, prints a one-line status JSON. The
  CLI is the only surface that performs filesystem walks; the MCP server
  never shells out (ADR-015 *Resolved Decisions*).
- Container wiring in `src/core/container.ts`: `codeInventoryService` is
  constructed after Dolt resolution and passed as an optional collaborator
  to `codeIntelligenceService` and `searchService` (mirroring the `eventRepo?`
  pattern from M2). Tests covering the wiring with and without Dolt.

### Phase 4 — risk reasons + breadcrumb + status (PR #100)

- Two new `reasons` codes on `analyzeCodeRefImpact` and
  `detectChangedCodeRefs` in `src/code-intelligence/service.ts`:
  - `file_has_no_exports`: emitted when
    `inventoryService.getSymbolsForFile(path)` returns zero symbols **and**
    the file is in a code language. Hints at internal/test-only/dead code;
    does not change risk on its own.
  - `file_is_manifest`: emitted for `package.json`, `Cargo.toml`,
    `pyproject.toml`, `go.mod`, `pnpm-lock.yaml`, `Gemfile.lock`,
    `requirements.txt`, etc. Forces `risk: "high"` regardless of active-work
    links — manifest changes affect the whole project.
- Breadcrumb in `SearchService.buildContextPack(mode="code")` at
  `src/search/service.ts`. When the inventory has hits at paths NOT already
  surfaced in the pack, appends to `guidance`:
  *"Inventory has N additional symbol matches not surfaced in this pack —
  call code_query for the full list."*
  Exactly one breadcrumb per response; never appended when hits are already
  in the pack.
- `codeInventory` block on `monsthera status` via `registerStatProvider` in
  `src/core/status.ts`. Shape per ADR-017 §D9:
  `{ built, fileCount, symbolCount, languages, lastReindexAt?, staleFileCount?, degraded? }`.
  Reads from `service.getStatus()` only — never triggers a build.

### Phase 5 — docs & ship (this PR)

- This knowledge note (`code-intelligence-m3-implementation.md`).
- ADR-015 *Resolved Decisions* now points at ADR-017 for the M3 details.
- CLI cheatsheet (`monsthera-cli-command-cheatsheet.md`) already gained
  `code query` and `code reindex` rows in Phase 3 — re-verified during
  this phase, no rows missing.
- Smoke test against the Monsthera repo itself: `monsthera code reindex` +
  `monsthera code query SearchService` returns ranked hits with
  `class SearchService` at `src/search/service.ts:89` as the top match.
- **Bug fix surfaced by the smoke test.** The first end-to-end run yielded
  `symbolCount: 0` across 277 TypeScript files. Root cause: vscode-textmate's
  `Registry` caches "scope unavailable" lookups internally. When the
  Markdown grammar (which declares fenced-code embedded language scopes like
  `source.ts`) was loaded before a code language, the registry stored a
  null result for `source.ts` that persisted even after the TypeScript
  bundle was added to our `grammarsByScope` map. Fix: drop
  `registryPromise` whenever a language load registers new scopes, so the
  next `ensureRegistry()` rebuilds the registry with a clean lookup cache.
  Compiled `IGrammar` instances cached in `grammarByLanguage` survive
  because they are self-contained — the registry's role ends at
  compilation. Regression test in `extractor.test.ts` reproduces the
  Markdown-then-TypeScript sequencing that the previous unit tests missed
  (they reset state between every test, masking sequential interaction).

## Behavior

### Bootstrap (lazy on first query)

`CodeInventoryService` does **not** build the inventory at container start.
The first `code_query` (MCP) or `monsthera code query` (CLI) on an empty
inventory returns an empty hit list with the hint
*"Inventory has not been built yet. Run monsthera code reindex to build it."*
Build is triggered only by an explicit `reindex` (CLI) or `service.build()`
call. `monsthera status` reports `codeInventory: { built: false }` without
side effects (ADR-017 §D8).

This keeps `monsthera serve` and `monsthera status` snappy even on large
trees, and matches Layer 0's search-index pattern.

### Lazy mtime-per-file invalidation

The persisted JSON records every file's `mtimeMs`. On every query and
`getSymbolsForFile` call, the service compares recorded mtime against
`fs.statSync(path).mtimeMs` for the candidate paths. Mismatches trigger
re-extraction in memory; a debounced flush persists the new state. Tools
that overwrite files with identical mtimes (rare; some CI image-restoration
scripts) will produce stale entries until the next `code reindex` — flagged
in ADR-017 §D5 as acceptable risk with a 30-day staleness warning on
startup.

### `file_is_manifest` is the only inventory reason that changes risk

ADR-017 §D10 keeps the `risk` enum (`none|low|medium|high`) untouched in
M3. `file_is_manifest` raises risk to `high` because a manifest change
affects the whole project regardless of active-work links —
`analyzeCodeRefImpact` and `detectChangedCodeRefs` honour this even when no
work article is linked to the path. `file_has_no_exports` adds a hint to
the `reasons` array but does not change the `risk` value; downstream
heuristics (e.g. M5 policy gates) decide what to do with it.

When `inventoryService` is `undefined` (M2-only path), neither reason is
emitted and M2 behavior is byte-identical. Regression tests in
`tests/unit/code-intelligence/service.test.ts` and
`service.phase4.test.ts` confirm both branches.

### Breadcrumb fires only when meaningful

The `build_context_pack(mode="code")` breadcrumb runs `inventoryService.query`
with the same query as the pack and `limit: 50`. It appends only when the
inventory returns hits at paths that are NOT among the pack-surfaced
codeRefs. If the inventory is unbuilt, the query fails, or every inventory
hit is already in the pack, the breadcrumb stays silent — never a constant
addition (ADR-017 §D6).

### CLI vs MCP boundary

`monsthera code reindex` is the only place that shells `git ls-files`. The
MCP `code_query` tool reads from the loaded inventory plus on-demand
mtime-checked re-extraction; it never spawns a subprocess. This preserves
the deterministic, side-effect-free MCP server property that ADR-015
*Resolved Decisions* established for `code_detect_changes`.

The Zod schema at the MCP boundary throws on validation failure (the only
place in the M3 path where exceptions cross the domain boundary); domain
code returns `Result<T, StorageError>` everywhere else.

## Boundary

- **Discovery, not authoring.** TextMate scope-based extraction targets the
  ADR-015 M3 success criterion: *"agents can discover likely files/symbols
  before falling back to `rg`"*. False positives on pathological inputs
  (deeply nested template literals, malformed sources) are acceptable and
  documented; the use case is search, not refactoring or type-aware
  navigation.
- **No call resolution, no import graph.** Symbol-level risk scoring and
  importer-count weighting are deferred to M4 (provider bridge). Doing
  either on top of TextMate scopes would overclaim accuracy; the
  `SymbolExtractor` interface is the seam M4 will swap when it lands a
  tree-sitter or LSP-backed extractor.
- **Existing M1/M2 APIs are frozen.** Only `reasons` arrays grew. Any
  caller depending on the M1/M2 payload shape continues to work
  unchanged; the inventory-aware code paths are gated behind the optional
  `inventoryService?` dependency.
- **Dolt mirror is write-only from M3's perspective.** Reads always go
  through the in-memory map sourced from JSON. M4 may switch reads to
  Dolt when configured; M3 keeps the read path uniform across Dolt-on
  and Dolt-off deployments.
- **C++ scope disambiguation** (`.call.` vs `.definition.`) stays in the
  file-level degraded path until a dedicated PR addresses it (ADR-017
  §D7).

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run`, `pnpm build` — all
  green on `feature/code-intelligence-m3-phase-5-docs` before this PR
  opened. Same baseline confirmed on `main` after every phase merged.
- New unit suites: `tests/unit/code-intelligence/inventory/extractor.test.ts`,
  `service.test.ts`, `persistence.test.ts`,
  `tests/unit/code-intelligence/service.phase4.test.ts`,
  `tests/unit/search/service.phase4-breadcrumb.test.ts`,
  `tests/unit/tools/code-query-tool.test.ts`, plus container/status
  coverage for the new wiring.
- Smoke test on the Monsthera repo itself:
  - `monsthera code reindex` builds the inventory across the working tree
    in seconds and prints `{ fileCount, symbolCount, languages, ... }`.
  - `monsthera code query SearchService` returns ranked hits including
    `src/search/service.ts` (the canonical owner) and the related test
    fixtures.
- Fixture coverage: every language under `tests/fixtures/code-intelligence/m3/`
  produces the exact expected symbol set; pathological input never throws;
  grammar loading is lazy (verified by the Python-only fixture not
  importing the Rust grammar).

## Phase mapping (PRs)

| Phase | PR | Title |
|---|---|---|
| Plan + ADR-017 | #96 | `feat(code-intelligence): plan + ADR-017 for M3 lightweight inventory` |
| Phase 1 | #97 | `feat(code-intelligence): M3 phase 1 — TextMate symbol extractor` |
| Phase 2 | #98 | `feat(code-intelligence): M3 phase 2 — service & persistence` |
| Phase 3 | #99 | `feat(code-intelligence): M3 phase 3 — code_query MCP tool + CLI surfaces` |
| Phase 4 | #100 | `feat(code-intelligence): M3 phase 4 — risk reasons + breadcrumb + status surface` |
| Phase 5 | this PR | `feat(code-intelligence): M3 phase 5 — docs + smoke test + ship` |
