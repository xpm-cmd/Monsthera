# Implementation prompt — Code Intelligence M3 (Lightweight Code Inventory)

> Hand this entire document to a fresh Claude Code agent session. The
> prompt is self-contained: it does not assume any memory of the
> planning session that produced ADR-017 and the M3 work article.

---

## Your task

Implement Milestone 3 of ADR-015 (Code Intelligence Strategy) in
[Monsthera](https://github.com/xpm-cmd/Monsthera). The architectural
decisions are already locked in
[`docs/adrs/017-code-intelligence-m3-lightweight-inventory.md`](../adrs/017-code-intelligence-m3-lightweight-inventory.md).
A planning PR shipped the ADR, a work article (`w-w7yhmqse`), and a TS
contract scaffold (`src/code-intelligence/inventory/`). Your job is to
turn the contract into a working implementation, in five phases, and
ship it through normal PR flow.

You do **not** redesign. You do **not** re-litigate decisions. ADR-017
is the contract. If something seems wrong, raise it as a PR comment —
do not deviate unilaterally.

---

## Starting state (verify before doing anything)

- **Repo**: `https://github.com/xpm-cmd/Monsthera`, primary working
  directory `/Users/xpm/Projects/Github/Monsthera`.
- **Base branch**: `main`, expected at commit `587961f` or newer
  (check with `git log --oneline -5`). The relevant commit is
  `feat(code-intelligence): plan + ADR-017 for M3 lightweight inventory`.
- **Your branches**: create one branch per phase (`feature/code-intelligence-m3-phase-1`,
  `…-phase-2`, etc.) so each PR is reviewable independently. Do NOT
  reuse `feature/code-intelligence-m3-plan` (that is the planning PR).
- **Work article**: `w-w7yhmqse`. Currently in `phase: planning`.
  Advance it through `enrichment → implementation → review → done` as
  you progress (`monsthera work advance w-w7yhmqse <phase>`).

## Bootstrap (run before any other tool call)

1. `ToolSearch query="monsthera" max_results=15` to load Monsthera MCP
   tools if available. If zero results, Monsthera MCP is not registered
   for this project — proceed with Read/Grep/Bash directly.
2. If Monsthera MCP loaded, run:
   - `monsthera__status()` — confirm health.
   - `monsthera__build_context_pack(query="code intelligence inventory M3 TextMate", mode="code", verbose=true)` — pull the curated context.
   - `monsthera__get_article("k-6qapdb1a")` and `monsthera__get_article("k-code-intel-m2-impl")` — M1/M2 implementation notes.
3. `pnpm install --prefer-offline` (the project uses pnpm@10.6.5,
   Node 22+).
4. Confirm the existing surfaces are green before you start:
   `pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build`.

## Required reading (in order)

1. [`docs/adrs/017-code-intelligence-m3-lightweight-inventory.md`](../adrs/017-code-intelligence-m3-lightweight-inventory.md)
   — the contract. Read it twice.
2. [`docs/adrs/015-code-intelligence-strategy.md`](../adrs/015-code-intelligence-strategy.md)
   — parent strategy, the layered model.
3. [`docs/adrs/014-portable-workspace-operations.md`](../adrs/014-portable-workspace-operations.md)
   — the JSON-first / Dolt-optional rule that ADR-017 D1 honors.
4. [`knowledge/work-articles/w-w7yhmqse.md`](../../knowledge/work-articles/w-w7yhmqse.md)
   — the M3 work article (objectives, scope, phases, acceptance gates).
5. [`knowledge/notes/code-ref-intelligence-mvp-implementation.md`](../../knowledge/notes/code-ref-intelligence-mvp-implementation.md)
   — M1 service shape.
6. [`knowledge/notes/code-ref-intelligence-m2-implementation.md`](../../knowledge/notes/code-ref-intelligence-m2-implementation.md)
   — M2 CLI/dashboard/event patterns.
7. [`src/code-intelligence/service.ts`](../../src/code-intelligence/service.ts)
   — existing service you'll extend.
8. [`src/code-intelligence/inventory/types.ts`](../../src/code-intelligence/inventory/types.ts)
   and [`extractor.ts`](../../src/code-intelligence/inventory/extractor.ts)
   — the contract scaffold. Do not break these signatures; only fill them in.
9. [`src/cli/code-commands.ts`](../../src/cli/code-commands.ts)
   — CLI surface you'll extend.
10. [`src/core/container.ts`](../../src/core/container.ts) — wiring
    pattern to follow.

---

## Architectural constraints (non-negotiable)

These are repeated from the project's CLAUDE.md, ADR-014, ADR-015, and
ADR-017. Violations will be rejected in review.

- **Domain code uses `Result<T, E>` from `src/core/result.ts`. Throws
  only at boundaries** (CLI exits, Zod validation in MCP).
- **No glob expansion in the API.** Globs expand in the caller (CLI,
  dashboard); the service receives concrete paths.
- **MCP server never shells out.** No `child_process`, no `git`, no
  filesystem walks beyond what the inventory needs to read. The CLI is
  where shelling lives.
- **JSON-first storage.** `.monsthera/cache/code-index.json` is the
  read source of truth. Dolt mirror is write-only and optional. Tests
  must work with `doltClient: null`.
- **No native dependencies.** `vscode-textmate`, `vscode-oniguruma`,
  and `@shikijs/langs` are pure-JS / WASM. Do not pull in
  `tree-sitter`, `oxc-parser`, `@swc/core`, `node-gyp`-built packages,
  or anything that requires a platform-specific prebuild.
- **Exact-pin** the new deps in `package.json` (no `^`, no `~`).
- **No glob in tests either.** Fixture files are loaded by explicit
  path.
- **Existing M1/M2 APIs are frozen.** `code_get_ref`,
  `code_find_owners`, `code_analyze_impact`, `code_detect_changes` keep
  their payload shape; only the `reasons` array gains new entries
  (`file_has_no_exports`, `file_is_manifest`).

---

## Phase plan

Each phase ships its own PR. Each PR runs `pnpm typecheck`, `pnpm
lint`, `pnpm vitest run`, and `pnpm build` green before opening. Mark
the work article phase via `monsthera work advance w-w7yhmqse <phase>`
when you start phase 3 (implementation) and again when you start phase
5 (review).

### Phase 1 — Extractor (TextMate plumbing)

**Branch**: `feature/code-intelligence-m3-phase-1-extractor`.

**Add runtime deps** (exact-pinned):
- `vscode-textmate` (latest 9.x as of April 2026)
- `vscode-oniguruma` (latest 2.x)
- `@shikijs/langs` (latest 4.x)

**Implement** `TextMateSymbolExtractor implements SymbolExtractor` in
`src/code-intelligence/inventory/extractor.ts` (replace the placeholder
interface-only file). Token filter rule per ADR-017 D2:

```ts
const SYMBOL_SCOPE = /^entity\.name\.(function|type)(\.|$)/;
const EXCLUDED_SCOPE = /^entity\.name\.function\.call(\.|$)/;
```

Map TextMate scope kinds to the `ArtifactKind` union:
- `entity.name.function.*` (excluding `.call.*`) → `"function"`
- `entity.name.type.class.*` → `"class"`
- `entity.name.type.interface.*` → `"interface"`
- `entity.name.type.alias.*` → `"type"`
- `entity.name.type.enum.*` → `"enum"`
- `entity.name.type.module.*` / `entity.name.namespace.*` → `"namespace"` (or `"module"` per language convention)
- `entity.name.type.record.*` → `"record"`

**Per-language fixtures** under
`tests/fixtures/code-intelligence/m3/`:

```
typescript.fix.ts   — function/class/interface/type/enum, generic, decorator
tsx.fix.tsx         — component declaration, hook
javascript.fix.js   — function/class/const arrow function
python.fix.py       — def/class/decorator/async def/multi-line def
go.fix.go           — func/method/type/struct/interface
rust.fix.rs         — fn/struct/enum/trait/impl
ruby.fix.rb         — def/class/module
markdown.fix.md     — file-level only (no symbols expected)
unknown.fix.xyz     — file-level only (degraded path)
```

Each fixture is 30-50 lines. Keep them as plain test data, not real
code — the goal is exercise of the extractor, not a runnable program.

**Unskip and pass** the placeholder tests in
`tests/unit/code-intelligence/inventory/extractor.test.ts`. Add tests
that confirm:
- Each fixture produces the exact expected symbol set.
- Pathological input (random bytes, deeply nested templates) returns
  `[]` and never throws.
- Lazy grammar loading: a Python fixture parse does not load the Rust
  grammar.

**Acceptance for Phase 1 PR**:
- All four green commands.
- All Phase 1 fixtures pass.
- No new MCP tool wiring yet (extractor is unused outside tests).
- Bundle size impact: `pnpm build` output diff is documented in PR
  description (expected ~+800 KB).

---

### Phase 2 — Service and persistence

**Branch**: `feature/code-intelligence-m3-phase-2-service`.

**Implement** `CodeInventoryService` in
`src/code-intelligence/inventory/service.ts` with these methods:

```ts
class CodeInventoryService {
  async build(): Promise<Result<CodeInventorySnapshot, StorageError>>;
  async query(input: CodeQueryInput): Promise<Result<CodeQueryResult, StorageError>>;
  async getStatus(): Promise<Result<CodeInventoryStatus, StorageError>>;
  async reindex(opts?: { full?: boolean }): Promise<Result<CodeInventoryStatus, StorageError>>;
  async getSymbolsForFile(path: string): Promise<Result<readonly CodeArtifact[], StorageError>>;
}
```

**Implement** `JsonInventoryPersistence` in
`src/code-intelligence/inventory/persistence.ts`:
- JSON read/write under `.monsthera/cache/code-index.json` using the
  same `proper-lockfile` pattern as the file repos
  (see `src/knowledge/repository.ts` for the canonical usage).
- Optional Dolt mirror exposed via a `null doltClient` short-circuit.
  Schema migration registered with the `runMigrations` runner from
  PR #94. Tables `code_artifacts(id, kind, name, path, language,
  start_line, end_line, exported, scope, stale)` and
  `code_relations(source_id, target_id, kind, confidence)`. Include
  appropriate indices (`path`, `kind`, `language`).
- Lazy mtime-per-file invalidation: on every `query` and
  `getSymbolsForFile`, compare recorded `mtimeMs` with
  `fs.statSync(path).mtimeMs`. If different, re-extract and update
  in-memory + debounced flush.

**File walk for `build()`**:
- Honor `.gitignore` (use `git ls-files` via the CLI surface, not the
  service — the service receives the file list as input). The
  `monsthera code reindex` CLI command shells `git ls-files` and feeds
  the result to `service.build({ paths })`.
- Skip symlinks. Skip files >1 MB. Skip files whose first 4 KB
  contains a null byte (binary detection).

**Acceptance for Phase 2 PR**:
- Unit tests covering: build from a small synthetic repo (15 files,
  4 languages), incremental query with one stale file, full reindex
  detecting a new file, persistence round-trip, Dolt mirror with a
  stub client, graceful degradation on Dolt failure (warning logged,
  JSON still works).
- A new `tests/unit/code-intelligence/inventory/service.test.ts` and
  `persistence.test.ts`.
- Cold-build time documented in PR for the synthetic 15-file repo
  (sanity benchmark, not a performance SLA).
- The service is **not yet wired into the container** — that lands in
  Phase 3.

---

### Phase 3 — MCP tool and CLI surfaces

**Branch**: `feature/code-intelligence-m3-phase-3-surfaces`.

**Wire `codeInventoryService` into `src/core/container.ts`** as a new
field. Construct it after `doltClient` resolution and pass it as an
optional dependency to `CodeIntelligenceService` (mirror the
`eventRepo?` pattern from M2).

**Implement the MCP tool `code_query`** in
`src/tools/code-query-tool.ts`. Zod schema:

```ts
const CodeQuerySchema = z.object({
  query: z.string().min(2).max(200),
  kinds: z.array(z.enum([
    "function", "class", "interface", "type",
    "enum", "namespace", "module", "record", "file",
  ])).optional(),
  paths: z.array(z.string().min(1)).max(100).optional(),
  languages: z.array(z.string()).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
```

Register it in `src/server.ts` alongside the existing four `code_*`
tools. The tool reads from the in-memory inventory; if the inventory
is not yet built, the response is
`{ hits: [], summary: { hitCount: 0, … }, recommendedNextActions: ["Inventory has not been built yet. Run monsthera code reindex to build it."] }`.

**Extend `src/cli/code-commands.ts`** with two new subcommands:

- `monsthera code query <text> [--kinds <list>] [--paths <list>] [--languages <list>] [--limit <n>]`
   → JSON-only on stdout, errors to stderr, non-zero exit on error.
- `monsthera code reindex [--full]`
  → shells `git ls-files` to get the file list, feeds it to
   `service.build()`, prints a one-line status JSON on stdout.

Update `printCodeHelp()` and the cheatsheet
(`knowledge/notes/monsthera-cli-command-cheatsheet.md`) to include the
new subcommands.

**Acceptance for Phase 3 PR**:
- `code_query` MCP tool tested against a stubbed service in
  `tests/unit/tools/code-query-tool.test.ts` (validation, happy path,
  inventory-not-built, ranking, limit).
- CLI tests covering each subcommand (group help, missing arg, happy
  path, JSON shape, error to stderr).
- Container test asserts that the inventory wires correctly with and
  without Dolt.

---

### Phase 4 — Risk and guidance integration

**Branch**: `feature/code-intelligence-m3-phase-4-integration`.

**Extend `analyzeCodeRefImpact` and `detectChangedCodeRefs`** in
`src/code-intelligence/service.ts` to add two new `reasons` codes when
the inventory is wired:

- `file_has_no_exports`: when `inventoryService.getSymbolsForFile(path)`
  returns zero symbols *and* the file is in a code language. Does not
  affect the `risk` enum.
- `file_is_manifest`: when the path matches a manifest pattern
  (`package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`,
  `pnpm-lock.yaml`, `Gemfile.lock`, `requirements.txt`, etc.). Forces
  `risk: "high"` regardless of active-work links — manifest changes
  affect the whole project.

When `inventoryService` is `undefined`, **the M2 behavior is exactly
preserved**. Add regression tests confirming this.

**Extend `build_context_pack(mode="code")`** with the breadcrumb. In
`src/context/service.ts` (or wherever the pack is assembled), when the
mode is `"code"` and `codeInventoryService.query({ query: <user-query>, limit: 1 })`
returns `summary.hitCount > 0` for hits NOT already surfaced in the
pack, append to `recommendedNextActions`:

> "Inventory has N additional symbol matches not surfaced in this pack — call code_query for the full list."

The breadcrumb is a single string, never repeated, never appended when
hits are already in the pack.

**Extend `monsthera status`** in `src/core/status.ts` with the
`codeInventory` block per ADR-017 D9:

```ts
codeInventory?: {
  built: boolean;
  fileCount: number;
  symbolCount: number;
  languages: readonly string[];
  lastReindexAt?: string;
  staleFileCount?: number;
  degraded?: { reason: string };
};
```

Status reads from `service.getStatus()` only — no build is triggered.

**Acceptance for Phase 4 PR**:
- M1/M2 regression tests still pass without modification.
- New tests for both `reasons` codes against synthetic inventories.
- Breadcrumb appears only when warranted.
- `monsthera status` round-trip test confirms the new block.

---

### Phase 5 — Documentation and ship

**Branch**: `feature/code-intelligence-m3-phase-5-docs`.

- **Knowledge note** `knowledge/notes/code-intelligence-m3-implementation.md`
  in the same shape as M1 and M2 notes (Summary / Added / Behavior /
  Boundary / Verification). Author it via the **monsthera CLI** if
  possible (`monsthera knowledge create`) or place a frontmatter-block
  file under `knowledge/notes/` and call `monsthera__status` once to
  trigger auto-indexing.
- **Update** `knowledge/notes/monsthera-cli-command-cheatsheet.md`
  with `code query` and `code reindex` rows.
- **Update** `docs/adrs/015-code-intelligence-strategy.md` "Resolved
  Decisions" section to point at ADR-017 for the M3 details.
- **Smoke test** with a real repo (the Monsthera repo itself works):
  `monsthera code reindex` then `monsthera code query SearchService`
  should return ranked hits.
- Advance the work article: `monsthera work advance w-w7yhmqse review`,
  then after the PR is approved and merged, `monsthera work advance
  w-w7yhmqse done`.

**Acceptance for Phase 5 PR**: all four green commands; smoke test
passes; knowledge note exists and is indexed.

---

## Verification protocol (run before opening every PR)

```sh
pnpm typecheck && pnpm lint && pnpm vitest run && pnpm build
```

If any fails, fix the root cause. Do not skip with `it.skip` or
`@ts-expect-error` unless the ADR explicitly authorizes it. The
existing ADR-017 placeholder skips will be unskipped by Phase 1 — none
should remain skipped after that.

Do **not** push to `main`. Do **not** force-push to a PR branch
without re-running the verification protocol.

---

## PR conventions

- **Title**: `feat(code-intelligence): M3 phase <N> — <topic>`. Example:
  `feat(code-intelligence): M3 phase 1 — TextMate symbol extractor`.
- **Body**: include
  - Summary (1-3 bullets)
  - Test plan checklist
  - Reference to ADR-017 §D<n> for each design choice landed
  - Co-Authored-By trailer per CLAUDE.md
- Open against `main`. Wait for human review before merging. Do not
  self-merge.

---

## Open questions in ADR-017 you may need to resolve as you go

These were left for the implementation to settle:

1. **Binary file detection**: ADR-017 proposes "skip when the first
   4 KB contains a null byte." Implement that and confirm in PR
   review; if the heuristic produces false negatives on real files,
   propose a refinement.
2. **Symlink policy**: ADR-017 proposes "skip symlinks." Implement
   that and confirm. If a user reports a legitimate use case for
   following symlinks within the repo, treat it as a follow-up PR.
3. **Inventory file size on huge monorepos**: if your synthetic
   benchmark in Phase 2 shows the JSON cache exceeding 50 MB on a
   reasonable extrapolation, propose gzipping or per-language
   chunking in the Phase 2 PR description. Do not change the format
   silently.
4. **Dolt schema column types**: pick conservative Dolt types
   (varchar(255) for ids/names, text for paths up to a length, int
   for line numbers). Document the chosen types in the migration file
   itself.

---

## Out of scope (do not expand)

- Importer-count weighting or any cross-file resolution. That belongs
  to M4 (provider bridge).
- Symbol-level risk scoring. Same.
- A `monsthera code status` subcommand. The `codeInventory` block in
  `monsthera status` is sufficient for M3.
- Native bindings. If you find yourself reaching for `tree-sitter` or
  `oxc-parser`, stop and re-read ADR-017 §D2.
- Refactoring M1/M2 service code beyond what is needed to add the two
  new `reasons` codes. The ADR explicitly mandates that those surfaces
  remain backwards-compatible.
- C++ scope disambiguation (`.call.` vs `.definition.`). C++ stays in
  the file-level degraded path until a dedicated PR addresses it.

---

## Communication

If you hit a genuine ambiguity ADR-017 does not address, post a comment
in the work article (`monsthera work comment w-w7yhmqse "..."`) and
flag it in your PR description. Do not invent a decision — surface it
for review.

If a decision in ADR-017 turns out to be wrong (e.g., TextMate proves
inadequate during Phase 1 fixture work), open an issue, do not patch
around it. The fix is to amend the ADR with a follow-up entry, not to
deviate silently in code.

---

## Done when

- All five phases shipped.
- Work article `w-w7yhmqse` is in `phase: done`.
- Knowledge note `code-intelligence-m3-implementation.md` is indexed.
- `monsthera code query SearchService` against the Monsthera repo
  itself returns ranked hits in <1 second.
- The four `pnpm` commands are green on `main` after the final merge.

Good luck.
