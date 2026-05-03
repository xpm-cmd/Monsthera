---
id: w-w7yhmqse
title: Implement Code Intelligence M3 — Lightweight Code Inventory
template: feature
phase: planning
priority: high
author: agent-architect
tags: [code-intelligence, m3, inventory, planning, adr-017]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-28T12:05:03.416Z
updatedAt: 2026-04-28T12:05:03.416Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"agent-architect","status":"pending"},{"role":"testing","agentId":"agent-architect","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-28T12:05:03.416Z"}]}
---

## Objective

Implement Milestone 3 of ADR-015 (Code Intelligence Strategy) per the
concrete decisions locked in ADR-017. M3 ships a lightweight,
multi-language symbol-and-file inventory derived under
`.monsthera/cache/code-index.json`, exposes it through a new `code_query`
MCP tool plus a breadcrumb in `build_context_pack(mode="code")`, and
threads two new conservative `reasons` codes into the existing M1/M2
risk surfaces.

## Background

Read first:

- `docs/adrs/017-code-intelligence-m3-lightweight-inventory.md` — the
  full decision record covering all ten open questions from
  ADR-015 M3.
- `docs/adrs/015-code-intelligence-strategy.md` — the parent strategy
  ADR.
- `knowledge/notes/code-ref-intelligence-mvp-implementation.md` — M1
  service layer.
- `knowledge/notes/code-ref-intelligence-m2-implementation.md` — M2 CLI,
  dashboard, and event plumbing.

ADR-017 locks the major architectural choices: TextMate grammars via
`vscode-textmate` + `vscode-oniguruma` + `@shikijs/langs` (no native
binding precedent broken; 120+ languages from day 1; ABI-churn risk
sidestepped). `code_query` is a new MCP tool plus a one-line breadcrumb
in `build_context_pack`. Storage is JSON canonical with optional Dolt
mirror. Cache invalidation is lazy mtime-per-file. Bootstrap is lazy on
first query.

## Scope

### In scope

- `CodeInventoryService` under `src/code-intelligence/inventory/` with
  the type and extractor seams already scaffolded in this PR
  (`types.ts`, `extractor.ts`).
- `TextMateSymbolExtractor` implementation that loads grammars
  on-demand via `@shikijs/langs/<lang>` and filters tokens by
  `entity.name.function.*` and `entity.name.type.*` scopes (excluding
  `entity.name.function.call.*`).
- JSON persistence at `.monsthera/cache/code-index.json` with optional
  Dolt mirror (`code_artifacts`, `code_relations` tables) when Dolt is
  available; never required.
- New MCP tool `code_query` registered in `src/server.ts` with a Zod
  schema covering `query`, `kinds`, `paths`, `languages`, `limit`.
- New CLI subcommands `monsthera code query <text> [...flags]` and
  `monsthera code reindex [--full]`.
- Extension to `build_context_pack(mode="code")` adding a single-line
  breadcrumb when the inventory has relevant hits the pack did not
  surface.
- Extension to `monsthera status` `stats` block with a `codeInventory`
  field per ADR-017 D9.
- Two new `reasons` codes in `analyzeCodeRefImpact`:
  `file_has_no_exports` and `file_is_manifest`.
- Per-language fixture files under `tests/fixtures/code-intelligence/m3/`
  and unit tests for the extractor, service, and persistence layers per
  ADR-017 D7.

### Out of scope

- Native bindings of any kind (tree-sitter, oxc-parser, swc). Considered
  and rejected in ADR-017 D2.
- Importer-count weighting in risk scoring. Deferred to M4 (provider
  bridge) which can do real import resolution.
- File watcher for live inventory updates. Lazy mtime polling is
  sufficient.
- Symbol-level risk scoring. Same reason — needs provider-grade
  precision.
- Changes to existing M1/M2 APIs (`code_get_ref`, `code_find_owners`,
  `code_analyze_impact`, `code_detect_changes`). M3 extends; it does
  not break.

## Phases

### Phase 1 — Extractor (TextMate plumbing)

- Add runtime deps: `vscode-textmate`, `vscode-oniguruma`,
  `@shikijs/langs`. Pin exact versions per ADR-017 (no `^`/`~`).
- Implement `TextMateSymbolExtractor` against the `SymbolExtractor`
  interface already scaffolded.
- Per-language fixture files in `tests/fixtures/code-intelligence/m3/`
  for TS, TSX, JS, Python, Go, Rust, Ruby, Markdown.
- Unskip and pass the placeholder tests in
  `tests/unit/code-intelligence/inventory/extractor.test.ts`.

Acceptance: extractor returns expected symbol sets for every fixture
and never throws.

### Phase 2 — Service and persistence

- `CodeInventoryService` with `build`, `query`, `getStatus`,
  `reindex(full?)`, and `extractFile` methods.
- JSON persistence in `.monsthera/cache/code-index.json` using the
  `proper-lockfile` pattern already adopted for the file repos.
- Lazy mtime-per-file invalidation at query time.
- Optional Dolt mirror behind a `null doltClient` guard. Schema
  migration registered with the runner introduced in PR #94.

Acceptance: service builds the inventory once on first query; subsequent
queries are mtime-incremental; Dolt mirror is exercised by an
integration test with a stubbed client.

### Phase 3 — MCP tool and CLI surfaces

- Register `code_query` in `src/server.ts` alongside the existing
  `code_*` tools.
- Add `monsthera code query` and `monsthera code reindex` to
  `src/cli/code-commands.ts`.
- Wire `codeInventoryService` in `src/core/container.ts` and pass it
  as the optional collaborator to `CodeIntelligenceService`.

Acceptance: tool registry test passes; CLI tests cover happy path,
help text, and the empty-result case; container test asserts the
inventory wiring with and without Dolt.

### Phase 4 — Risk and guidance integration

- Add `file_has_no_exports` and `file_is_manifest` reasons codes to
  `analyzeCodeRefImpact` and `detectChangedCodeRefs`.
- Add the breadcrumb to `build_context_pack(mode="code")`.
- Extend the `monsthera status` payload with `codeInventory`.

Acceptance: regression tests confirm the M1/M2 outputs are unchanged on
the no-inventory path; new reasons fire only when the inventory says so.

### Phase 5 — Documentation and ship

- Knowledge note `code-intelligence-m3-implementation.md` summarizing
  what shipped (parallel to the M1 and M2 notes).
- Update `monsthera-cli-command-cheatsheet.md` with the new code
  subcommands.
- Update README and `docs/adrs/015-code-intelligence-strategy.md`
  Resolved-Decisions section pointing at ADR-017.

Acceptance: `pnpm typecheck`, `pnpm lint`, `pnpm vitest run`,
`pnpm build` are all green; smoke-test with a 5,000-file repo confirms
cold-build under 30 s and incremental query under 1 s.

## Acceptance criteria (success-gates)

1. **Discovery beats `rg`**: an agent can call `code_query` to find a
   symbol or file by name across 13+ languages without falling back
   to the shell.
2. **Inventory is portable**: the project works with Dolt off,
   on-but-degraded, and on-and-fully-available; the JSON cache is the
   single source of read truth in all three modes.
3. **No new native dependencies**: `pnpm install` succeeds without
   `node-gyp` or platform-specific prebuilds.
4. **Lazy bootstrap**: `monsthera status` never blocks on building
   the inventory; the first `code_query` call performs the build.
5. **Existing surfaces unchanged**: `code_get_ref`, `code_find_owners`,
   `code_analyze_impact`, `code_detect_changes` keep their M1/M2
   payload shape; only `reasons` arrays are extended.
6. **Status visibility**: `monsthera status` reports inventory file
   count, symbol count, languages, last-reindex timestamp, and stale
   count.
7. **Conservative risk**: the inventory contributes two new
   well-defined `reasons` codes; the `risk` enum (`none|low|medium|high`)
   keeps its M2 semantics.

## Risks and mitigations

- **TextMate scope drift across language updates** — Shiki rebuilds
  daily from upstream; pin `@shikijs/langs` exact version and rebuild
  lock on each bump. CI test loads each grammar.
- **JSON file size on huge monorepos** — measure on a 20,000-file
  fixture during Phase 2; if >50 MB, switch to gzipped or per-language
  chunked JSON. Decision deferred until measured.
- **C++ scope ambiguity** (`.call.` vs `.definition.`) — out of M3
  scope; documented in ADR-017 D7. C++ falls into the file-level
  degraded path until a dedicated PR addresses it.

## References

- ADR-017 (this work's decision record): `docs/adrs/017-code-intelligence-m3-lightweight-inventory.md`
- ADR-015: `docs/adrs/015-code-intelligence-strategy.md`
- M1 note: `knowledge/notes/code-ref-intelligence-mvp-implementation.md`
- M2 note: `knowledge/notes/code-ref-intelligence-m2-implementation.md`
