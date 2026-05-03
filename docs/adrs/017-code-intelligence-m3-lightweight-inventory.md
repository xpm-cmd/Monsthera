# ADR-017: Code Intelligence M3 — Lightweight Code Inventory

**Status:** Accepted
**Date:** 2026-04-28
**Decision makers:** Architecture team
**Supersedes:** none. Extends ADR-015 Layer 2 with concrete implementation choices.

## Context

ADR-015 ("Code Intelligence Strategy") laid out a five-milestone capability ladder.
Milestones M1 and M2 shipped in commits `4270571` and `bfe65c7`:

- `CodeIntelligenceService` exposing `getCodeRef`, `findCodeOwners`,
  `analyzeCodeRefImpact`, and `detectChangedCodeRefs`
- MCP tools `code_get_ref`, `code_find_owners`, `code_analyze_impact`,
  `code_detect_changes`
- `monsthera code <ref|owners|impact|changes>` CLI surface
- Standalone `/code` dashboard page
- Internal-only `code_high_risk_detected` orchestration event

Layer 1 answers "what Monsthera context is affected by this path?" without parsing
any source. It is fast, dependency-free, and conservative — but it is blind to
the *contents* of the files it tracks. An agent looking for a function called
`buildContextPack` cannot ask Monsthera; it has to fall back to `rg`.

ADR-015 Milestone 3 ("Lightweight Inventory") was specified at the strategic
level but left several implementation choices open. This ADR resolves those
choices and locks the implementation contract before code lands.

The scope is narrow: a portable, derivable, multi-language **symbol and file
inventory** that augments code-ref intelligence — not a full AST graph, not a
call resolver, not a refactoring engine. Those remain the province of
Milestone 4 (provider bridge).

## Decision

Build M3 as a service-layer component that derives `.monsthera/cache/code-index.json`
from the working tree, exposes structured queries through new MCP and CLI
surfaces, and feeds optional facts into the existing M1/M2 risk surfaces.

The full set of locked decisions follows. Each is motivated by ADR-015's
existing constraints (conservative, derived, portable) and ADR-014's
portable-workspace contract (everything must work without Dolt).

### D1. Storage location

**JSON canonical at `.monsthera/cache/code-index.json` plus optional Dolt
mirror.**

The JSON file is the authoritative read surface. When Dolt is reachable and
enabled, the inventory mirrors itself into Dolt-backed `code_artifacts` and
`code_relations` tables to enable future SQL-based queries (M4 provider
bridge will use these). When Dolt is unavailable — the typical user setup or
any `--allow-degraded` boot — the JSON file is sufficient on its own.

This honors ADR-014's portability rule (markdown + JSON always work) and
ADR-015's derived-state rule (line 148: "store inventory under
`.monsthera/cache/`, because it is derived and rebuildable"). The JSON
loads into memory on first query and stays resident; the working set for a
5,000-file repo is ~10 MB, which is acceptable.

The Dolt mirror is **write-only from M3's perspective**: queries always read
from the in-memory map. M4 may switch reads to Dolt when present; M3 does
not, to keep the read path uniform across Dolt-on and Dolt-off deployments.

### D2. Symbol extractor

**TextMate via `vscode-textmate` + `vscode-oniguruma` + `@shikijs/langs` (per-language imports).**

Parser stack:

- `vscode-textmate` (95 KB) — Microsoft's grammar interpreter, the same
  engine VS Code uses for syntax highlighting.
- `vscode-oniguruma` (~507 KB, mostly the WASM regex engine) — pure-WASM
  Oniguruma regex runtime; no native bindings, no `node-gyp`.
- `@shikijs/langs/<lang>` — per-language ESM imports from Shiki's grammar
  bundle. 253 grammars total in the v4.0.x line, sourced daily from VS Code
  and GitHub linguist. Lazy-loaded: a grammar is imported only when the
  inventory first encounters a file with that extension.

Symbol kinds extracted: function declarations, class declarations, interface
declarations, type aliases, enum declarations, namespace declarations.

Filter rule: tokens whose scope matches `/^entity\.name\.function(\.|$)/`
or `/^entity\.name\.type\.(class|interface|alias|enum|namespace|module|record)(\.|$)/`,
**excluding** `entity.name.function.call.*` (call sites, not declarations —
relevant for C++ where the convention separates them).

#### Why TextMate over alternatives

The brainstorm round considered four families: anchored regex, TypeScript
compiler API, native bindings (tree-sitter or `oxc-parser` or `@swc/core`),
and TextMate. TextMate won on five criteria:

| | Regex | TS compiler API | tree-sitter (curated) | oxc-parser | TextMate |
|---|---|---|---|---|---|
| Install footprint | ~0 | ~80 MB | ~5 MB | ~3 MB native | ~1 MB |
| Native binding precedent broken | no | no | no | **yes** | no |
| Multi-language day 1 | TS only | TS only | 8 langs | TS/JS only | **120+ langs** |
| Accuracy | low | high | high | high | medium |
| Maintenance load | low | low | low | medium (0.x semver) | low |

The decisive consideration is that ADR-015's M3 success criterion is
*"agents can discover likely files/symbols before falling back to `rg`"* —
**discovery, not authoring**. TextMate's scope-based extraction is precisely
what "conservative" looks like in practice: it identifies declarations
without claiming to know type relationships, call edges, or cross-file
references. A 95% recall over 120+ languages with zero native dependencies
and stable file format (TextMate has been stable for 15+ years) beats a
99% recall over 8 languages at the cost of breaking the project's
zero-native-dependencies precedent.

#### ABI and version risk

Tree-sitter's WASM ABI churn (ABI bump to 15 in tree-sitter 0.25.0,
February 2026, breaking grammars compiled against earlier CLI versions —
issue #5171) was the main concern that ruled out tree-sitter for now.
TextMate has no equivalent: the grammar JSON format has been stable since
2014. Shiki republishes grammars daily from VS Code and linguist sources,
so language evolution is tracked automatically.

#### Upgrade path documented

When M4 (provider bridge) needs AST-precise multi-language analysis (for
example, cross-file type resolution or call-graph hints), the path is:
introduce `@vscode/tree-sitter-wasm` exact-pinned, plus a CI smoke test
that loads each grammar and parses a fixture, behind the same
`SymbolExtractor` interface introduced in M3. M3's TextMate implementation
becomes a fallback for languages the curated bundle does not cover.

### D3. Languages supported in M3 ship

**Initial bundle: TypeScript, TSX, JavaScript, JSX, Python, Go, Rust, Java,
Ruby, Markdown, JSON, YAML, TOML.**

Files in unknown languages degrade to **file-level entries** (path,
extension, size, mtime) without symbol extraction. This matches ADR-015
line 153 ("unknown languages degrade to file-level indexing").

Adding a new language is a one-line PR: import the grammar from
`@shikijs/langs/<lang>` and add the extension to the dispatch map. No
schema migration; the inventory schema does not encode the language list.

Lazy-load: grammars are imported only when the inventory first encounters
a matching file. A repo with no Python files never pays the ~30 KB cost
of the Python grammar.

### D4. New `code_query` tool plus breadcrumb in `build_context_pack`

**Both surfaces. A new `code_query` MCP tool for direct structured queries,
and a one-line breadcrumb in `build_context_pack(mode="code")` responses
when the inventory has relevant hits the pack did not surface.**

`code_query` shape (Zod schema):

```ts
{
  query: string,                    // required, ≥2 chars
  kinds?: ("function" | "class" | "interface" | "type" | "enum" | "namespace" | "file")[],
  paths?: string[],                 // expanded by the caller; matched as exact + directory-prefix
  languages?: string[],
  limit?: number                    // default 50, max 500
}
```

Returns: ranked hits with `{path, symbol, kind, language, line, scope}` per
match, plus a `summary` block and `recommendedNextActions` per the rule in D6.

`build_context_pack(mode="code")` adds a single string to its existing
guidance array when `inventoryHasRelevantHits === true`:

> "Inventory has N additional symbol matches not surfaced in this pack — call code_query for the full list."

Both surfaces are needed because they answer different questions:

- `code_query` is the right tool when the agent already knows it is searching
  for something specific (a symbol name, a kind filter, a path pattern).
- `build_context_pack` is the right tool when the agent is gathering
  narrative context. The breadcrumb avoids hiding the inventory from agents
  that did not know to ask for it.

ADR-015's *Consequences* warned that "more MCP tools can increase choice
overload unless guidance is designed well." The breadcrumb is exactly that
guidance.

### D5. Cache invalidation policy

**Lazy mtime-per-file at query time, plus a manual `monsthera code reindex`
command for forced full rebuilds.**

On first build, every file's `mtime` is recorded in the JSON alongside its
extracted symbols. On every query, before serving a hit from a given file,
the service compares the recorded `mtime` to `fs.statSync(path).mtimeMs`.
If they differ, the file is re-parsed and the inventory entry is updated
in memory and persisted on a debounced flush.

This is the same pattern Layer 0's search index uses (`lastReindexAt`).

What is **explicitly rejected**:

- File watchers. Continuous runtime cost; would interact badly with
  `--allow-degraded` mode and cross-platform packaging.
- Content hashing on every startup. N reads is a cold-start tax we cannot
  justify when mtime catches >99% of changes.
- Implicit rebuild on `monsthera status`. Status must remain a
  non-side-effecting read.

Edge case documented in code: tools that overwrite files with identical
mtime (rare; some CI image-restoration scripts) will produce stale
inventory entries until the next `code reindex`. Acceptable risk; emit a
log warning on startup if `lastReindexAt` is older than 30 days.

### D6. Next-step guidance threshold

**Append `recommendedNextActions` only when there is a concrete actionable
hint. Empty array when no action is meaningful.**

Concrete rules for `code_query`:

- ≥3 hits → "Run build_context_pack on the top hit to retrieve linked Monsthera context."
- `staleFileCount` ≥ 10% of inventory file count → "Inventory has N stale entries; consider monsthera code reindex."
- 0 hits → empty (no "try a different query" or "did you mean…" — pure noise).
- Inventory not yet built → "Inventory has not been built yet. Run monsthera code reindex to build it."

For `build_context_pack(mode="code")`, the breadcrumb fires only when
`inventoryHasRelevantHits === true`, never as a constant addition.

This rule is motivated by ADR-015's *Consequences* note that always-on
guidance becomes noise that agents learn to ignore.

### D7. Test fixtures

**Per-language fixture files in `tests/fixtures/code-intelligence/m3/`.**

Layout:

```
tests/fixtures/code-intelligence/m3/
├── typescript.fix.ts       (function/class/interface/type/enum, generic, decorator)
├── tsx.fix.tsx             (component declaration, hook)
├── javascript.fix.js
├── python.fix.py           (def/class, decorator, async def, multi-line def)
├── go.fix.go               (func/method/type/struct/interface)
├── rust.fix.rs             (fn/struct/enum/trait/impl)
├── ruby.fix.rb
├── markdown.fix.md         (file-level only)
└── unknown.fix.xyz         (file-level only — degraded path)
```

Each fixture is 30-50 lines, copyrightable as test data, exercising the
common declaration shapes plus one edge case per language. Vitest loads
each fixture, runs the extractor, and asserts an exact set of expected
symbols.

What is **out of M3 test scope**:

- Running the extractor against the real `src/` tree (becomes a benchmark,
  not a unit test).
- C++ scope disambiguation (`.call.` vs `.definition.`). Documented as a
  follow-up when a user asks for C++ support; covered by a dedicated
  fixture-and-test PR.

### D8. Bootstrap cost

**Lazy build on first query. `monsthera status` never triggers a build.**

`monsthera status` reports `codeInventory: { built: false }` when the
cache file does not exist; it does not block on building. The first
`code_query`, `code_get_ref` (when symbol enrichment is requested), or
`monsthera code reindex` call triggers the build, with a progress message
on stderr ("Building code inventory (~Xs)…"). Subsequent queries pay only
the mtime-incremental cost.

Estimated cold-build times (validated against the 258-file Monsthera repo
during research, extrapolated for larger trees):

| Repo size | Cold build | Incremental query (10% changed) |
|---|---|---|
| 250 files | ~2 s | <100 ms |
| 1,000 files | ~6 s | ~250 ms |
| 5,000 files | ~25 s | ~1 s |
| 20,000 files | ~90 s | ~3 s |

A 90-second cold build is a tolerable one-time wait when the user has just
run `monsthera code query`. It would be intolerable as a startup blocker.

### D9. `monsthera status` surface

**Compact `codeInventory` block in the existing `stats` response. No
separate command yet.**

Shape:

```ts
codeInventory?: {
  built: boolean;
  fileCount: number;
  symbolCount: number;
  languages: readonly string[];        // ["typescript", "python", ...]
  lastReindexAt?: string;              // ISO8601
  staleFileCount?: number;             // files with mtime > lastReindexAt
  degraded?: { reason: string };       // when JSON is fine but Dolt mirror failed
};
```

Rationale: the existing `stats` block already carries `searchIndexSize`,
`lastReindexAt`, and similar facts. `codeInventory` follows the same
shape. The `degraded` field surfaces partial failures (Dolt mirror down
but JSON intact) without making the whole subsystem look red.

A future `monsthera code status` subcommand for a per-language breakdown
is a candidate follow-up but is not part of M3's success criteria.

### D10. Inventory-aware risk scoring

**M3 enriches `analyzeCodeRefImpact` with two new conservative `reasons`
codes only. The `risk` enum (`none|low|medium|high`) does not change.**

New reasons:

- `file_has_no_exports` — emitted when the inventory says zero exported
  symbols are defined in this file. Hint that the path may be internal,
  test-only, or dead code; does not change risk on its own.
- `file_is_manifest` — emitted for `package.json`, `Cargo.toml`,
  `pyproject.toml`, `go.mod`, `pnpm-lock.yaml`, etc. Manifest changes
  affect the whole project; this raises risk to `high` regardless of
  active-work links.

What is **explicitly out of scope for M3**:

- Importer-count weighting ("this file has 47 importers"). Requires
  implementing import resolution, which the ADR-015 layering pushes to
  M4 (provider bridge). Doing it on top of TextMate scopes would be
  heuristic and overclaim accuracy.
- Symbol-level risk (changing `function foo` versus changing the file
  containing it). Same reason.

This preserves the M1/M2 API surface and avoids a breaking change.

## Components and architecture

### New module layout

```
src/code-intelligence/
├── service.ts                       (existing M1/M2)
├── inventory/
│   ├── types.ts                     (CodeArtifact, CodeRelation, CodeInventory)
│   ├── extractor.ts                 (SymbolExtractor interface; TextMate impl)
│   ├── service.ts                   (CodeInventoryService)
│   ├── persistence.ts               (JSON read/write + optional Dolt mirror)
│   ├── language-map.ts              (extension → grammar import dispatch)
│   └── index.ts
└── index.ts (re-export inventory + existing service)

src/tools/
└── code-query-tool.ts                (new MCP tool, registered in src/server.ts)

src/cli/
└── code-commands.ts                  (extended with `code query` and `code reindex`)

tests/unit/code-intelligence/
├── service.test.ts                   (existing M1/M2)
└── inventory/
    ├── extractor.test.ts             (per-language fixtures from tests/fixtures/...)
    ├── service.test.ts               (lifecycle: build, lookup, stale, reindex)
    └── persistence.test.ts           (JSON shape; Dolt mirror with stub)
```

### Container wiring

`MonstheraContainer` gains a `codeInventoryService` field. It is constructed
during `createContainer` after the existing `codeIntelligenceService` and is
passed in as an optional dependency to the latter so M1/M2 risk scoring can
read inventory facts when present and fall back to the M2 behavior when not.

```ts
const codeInventoryService = new CodeInventoryService({
  repoPath,
  logger,
  doltClient: container.doltClient ?? null,   // null in --allow-degraded
});

const codeIntelligenceService = new CodeIntelligenceService({
  ...,
  inventoryService: codeInventoryService,     // optional
});
```

The optional dependency mirrors the `eventRepo?` pattern from M2 — a single
service can run with or without the new collaborator, which keeps tests
simple and lets M1/M2 behavior be regression-tested without booting the
inventory.

### MCP server boundary

`code_query` is registered alongside the four existing `code_*` tools in
`src/server.ts`. The tool **never** shells out (consistent with ADR-015's
resolved decision on `code_detect_changes`). The CLI subcommand
`monsthera code reindex` is the only place that performs filesystem
walks; the MCP-side `code_query` operates strictly over the loaded JSON
plus on-demand mtime-checked re-extraction.

This preserves the MCP server's deterministic, side-effect-free property.

## Resolved decisions (summary table)

| # | Question | Resolution |
|---|---|---|
| 1 | Storage location | JSON canonical (`.monsthera/cache/code-index.json`); Dolt mirror optional, write-only from M3. |
| 2 | Symbol extractor | TextMate via `vscode-textmate` + `vscode-oniguruma` + per-language `@shikijs/langs`. |
| 3 | Languages supported | TS, TSX, JS, JSX, Python, Go, Rust, Java, Ruby, Markdown, JSON, YAML, TOML. Unknown → file-level. |
| 4 | `code_query` versus enrich | Both: new MCP tool plus breadcrumb in `build_context_pack(mode="code")`. |
| 5 | Cache invalidation | Lazy mtime-per-file at query time + manual `monsthera code reindex`. |
| 6 | Next-step guidance | Only when an action is concrete and meaningful; empty array otherwise. |
| 7 | Test strategy | Per-language fixture files; no live `src/` runs in tests. |
| 8 | Bootstrap cost | Lazy on first query; `monsthera status` never builds. |
| 9 | Status surface | Compact `codeInventory` block in `stats`; per-language breakdown deferred. |
| 10 | Inventory + risk scoring | Conservative: two new `reasons` codes only; `risk` enum unchanged. |

## Open questions

- **Dolt schema migration**: when the optional Dolt mirror lands, the
  schema-migration runner introduced in PR #94 must add `code_artifacts`
  and `code_relations` tables. The exact column shape for the relation
  edge (M3 only emits `contains` and `defines`; M4 will add `imports` and
  others) is deferred to the implementation PR.
- **Binary-file detection**: how should the inventory treat `.png`, `.pdf`,
  and other binary files in `src/`? Current proposal: skip silently when a
  read sees null bytes in the first 4 KB. Defer the final policy to
  implementation review.
- **Symlink policy**: follow or skip? Default for M3 is to skip symlinks
  to avoid cycles and out-of-repo drift. Revisit if a user reports a
  legitimate use case.

## Consequences

### Positive

- Agents can discover symbols across 120+ languages without falling back
  to `rg`, fulfilling ADR-015 M3's success criterion.
- The `SymbolExtractor` interface introduced here is the seam M4 will use
  to swap in tree-sitter-backed extraction for languages that need AST
  precision, without re-touching service or CLI surfaces.
- No new native dependencies. The project's "lightweight by design"
  posture (ADR-014) is preserved.
- Multi-language support arrives in M3 instead of being deferred to M4,
  so users with non-TypeScript stacks see value from the M3 ship.
- Existing M1/M2 APIs are unchanged. Adoption is opt-in via the new
  `code_query` tool and `code reindex` command; old workflows are
  unaffected.

### Negative

- TextMate scope-based extraction will produce occasional false positives
  on pathological inputs (deeply nested template literals, malformed
  files). Acceptable because the use case is discovery, not authoring,
  but documentation should set expectations.
- The optional Dolt mirror is dead code in deployments without Dolt.
  Mitigated by the `null doltClient` short-circuit and a single
  integration test that exercises the path with a stub.
- Cold-build latency on very large repos (>20k files) is non-trivial.
  Mitigated by lazy bootstrap and the `code reindex` escape hatch, but
  flagged for future work if user feedback identifies pain.
- One more MCP tool (`code_query`) adds choice-overload pressure. The
  breadcrumb-from-`build_context_pack` rule is the structural mitigation;
  effectiveness will be visible in agent-trace audits after a few weeks
  of use.

## References

- ADR-014: Portable Workspace Operations.
- ADR-015: Code Intelligence Strategy (parent).
- ADR-016: Self Update Rollback and Doctor.
- Knowledge note: `code-ref-intelligence-mvp-implementation` (M1).
- Knowledge note: `code-ref-intelligence-m2-implementation` (M2).
