# ADR-015: Code Intelligence Strategy

**Status:** Accepted
**Date:** 2026-04-26
**Decision makers:** Architecture team

## Context

Monsthera already helps agents work with code, but it does so through the
knowledge/work layer:

- knowledge and work articles carry `codeRefs`
- `build_context_pack` boosts code-linked and source-linked context
- `StructureService` turns articles, work, code refs, tags, dependencies, and
  references into a navigable graph
- snapshots bind semantic context to the physical sandbox
- lifecycle guards make code work auditable through phases, reviewers, policies,
  and implementation evidence

This is strong operational intelligence. It tells an agent what work exists,
why it exists, what context is trusted, who owns it, which policies apply, and
which files have been named as relevant.

It is not yet code intelligence in the GitNexus sense. Monsthera does not parse
the repository into symbols, call edges, imports, route handlers, tool handlers,
or execution flows. Its embeddings are over article text and code refs, not over
code symbols or code chunks. That distinction matters: Monsthera can explain why
`src/search/service.ts` matters to a work item, but it cannot yet answer "what
will break if I change `SearchService.buildContextPack`?"

The goal is not to clone a dedicated code graph engine. The goal is to add the
right code-intelligence surfaces while preserving Monsthera's core identity:
durable markdown-backed memory, explicit work contracts, policy-driven
orchestration, and agent handoff safety.

## Decision

Build code intelligence as a layered capability ladder.

Each layer must be useful on its own, degrade gracefully, and keep derived state
out of source-of-truth markdown. Monsthera should start with code-ref
intelligence, then add a lightweight code inventory, then support pluggable code
graph providers. Full AST/call-graph parsing is an optional provider, not a
mandatory core dependency.

## Layer 0: Existing Operational Code Context

This is what ships today.

Capabilities:

- `codeRefs` on knowledge and work articles
- stale code-ref validation through `StructureService`
- code-mode `build_context_pack`
- environment snapshots with lockfile and git metadata
- implementation guards requiring code refs before review

This layer should remain the foundation. It is cheap, stable, and directly tied
to agent workflow.

## Layer 1: Code-Ref Intelligence

Layer 1 requires no parser and no new runtime dependency. It derives richer
answers from existing `codeRefs`, article metadata, git state, and filesystem
facts.

New service:

```ts
interface CodeIntelligenceService {
  getCodeRef(ref: string): Promise<Result<CodeRefDetail, MonstheraError>>;
  findCodeOwners(ref: string): Promise<Result<CodeRefOwners, MonstheraError>>;
  analyzeCodeRefImpact(input: CodeRefImpactInput): Promise<Result<CodeRefImpact, MonstheraError>>;
  detectChangedCodeRefs(input: ChangedCodeRefInput): Promise<Result<ChangedCodeRefImpact, MonstheraError>>;
}
```

Suggested outputs:

- `CodeRefDetail`
  - normalized path
  - exists flag
  - absolute path
  - line anchor, if supplied
  - file size and mtime
  - linked knowledge articles
  - linked work articles
  - linked policies
  - open implementation/review work
- `CodeRefImpact`
  - direct article/work owners
  - active phases affected
  - policies whose content or code refs mention the path
  - convoys/events touching linked work
  - stale/missing link warnings
  - recommended next tool call
- `ChangedCodeRefImpact`
  - changed files from git diff
  - exact code-ref hits
  - directory-prefix hits
  - active work likely affected
  - review/policy risk summary

MCP tools (canonical `<domain>_<verb>` naming, consistent with `convoy_*`,
`agent_*`, and other Monsthera tool surfaces):

- `code_get_ref`
- `code_find_owners`
- `code_analyze_impact`
- `code_detect_changes`

CLI commands (deferred to Milestone 2 — see Resolved Decisions below):

- `monsthera code ref <path>`
- `monsthera code owners <path>`
- `monsthera code impact <path>`
- `monsthera code changes [--staged|--all|--base <ref>]`

Dashboard:

- a Code tab in the graph explorer
- clickable code nodes with owners and active work
- a "changed files impact" panel on Work and Flow pages

Why this layer first:

- It leverages Monsthera's existing strengths.
- It improves agent safety before and after edits.
- It avoids language-specific parser complexity.
- It gives humans an immediate operational view of code ownership.

## Layer 2: Lightweight Code Inventory

Layer 2 adds repository-wide indexing without full call resolution.

The inventory scans source files and extracts stable, low-risk facts:

- files
- directories
- package manifests
- exported symbols where cheap to detect
- import statements where cheap to detect
- tool definitions and handlers in Monsthera's own conventions
- route-like strings only when framework patterns are obvious

Implementation rules:

- Store inventory under `.monsthera/cache/`, because it is derived and
  rebuildable.
- Never write inventory facts into knowledge/work markdown automatically.
- Keep parser support opportunistic. Regex or TypeScript compiler APIs are
  acceptable only when they are conservative and tested.
- Unknown languages degrade to file-level indexing.

Possible data shape:

```ts
interface CodeArtifact {
  id: string;
  kind: "file" | "directory" | "symbol" | "route" | "tool" | "package";
  name: string;
  path: string;
  language?: string;
  startLine?: number;
  endLine?: number;
  exported?: boolean;
  stale?: boolean;
  metadata?: Record<string, unknown>;
}

interface CodeRelation {
  sourceId: string;
  targetId: string;
  kind: "contains" | "defines" | "imports" | "handles_tool" | "handles_route";
  confidence: "high" | "medium" | "low";
}
```

This layer unlocks:

- symbol-aware context packs for common languages
- file/symbol search without opening the whole repo
- `tool_map` equivalents for Monsthera MCP tools
- dashboard explorer with article/work/code in one graph
- better code-ref autocomplete and repair suggestions

## Layer 3: Pluggable Code Graph Provider

Layer 3 introduces a provider interface rather than a built-in AST engine.

```ts
interface CodeGraphProvider {
  readonly name: string;
  getStatus(): Promise<Result<CodeGraphStatus, MonstheraError>>;
  query(input: CodeGraphQuery): Promise<Result<CodeGraphQueryResult, MonstheraError>>;
  getSymbol(input: CodeSymbolLookup): Promise<Result<CodeSymbolContext, MonstheraError>>;
  impact(input: CodeImpactInput): Promise<Result<CodeImpactResult, MonstheraError>>;
  detectChanges(input: CodeChangeInput): Promise<Result<CodeChangeImpact, MonstheraError>>;
}
```

Provider modes:

- `none` - Layer 0/1/2 only
- `local-cache` - Monsthera lightweight inventory
- `external` - bridge to a dedicated code graph MCP/HTTP backend
- future `native-ast` - optional built-in parser package, if justified

This keeps Monsthera small by default while allowing advanced deployments to
wire a specialized engine.

MCP tools should not expose provider implementation details. Agents should call
Monsthera tools with stable names that follow the same `code_<verb>` convention
as Layer 1:

- `code_query`
- `code_context`
- `code_impact` (extends Layer 1 `code_analyze_impact` with provider-aware results)
- `code_detect_changes` (same name as Layer 1; provider results layered on)

When no advanced provider is configured, those tools return Layer 1/2 results
with an explicit `capability: "code_refs" | "inventory"` marker. When a provider
is configured, the same tool names return symbol/call/process-aware results.

The Layer 1 tool names (`code_get_ref`, `code_find_owners`, `code_analyze_impact`,
`code_detect_changes`) are stable as of M1. M4 will not rename them; it will
extend them through capability markers in the response payload.

## Layer 4: Agent Workflow Guidance

Code intelligence is only useful if agents actually use it at the right time.
Monsthera should add next-step guidance to tool responses, inspired by GitNexus
but tuned for Monsthera's lifecycle model.

Examples:

- after `search`: "Next: call `build_context_pack` before coding."
- after `build_context_pack` with stale refs: "Next: run `analyze_code_ref_impact`
  or repair stale refs before implementation."
- after `get_work` in `implementation`: "Next: record a snapshot, then run
  `detect_changed_code_refs` before review."
- after `advance_phase` to review: "Next: call `detect_changed_code_refs` and
  attach impacted refs to the work article."

This does not require a new model. It is product ergonomics at the MCP boundary.

## What Monsthera Should Not Do First

Do not start with a full AST parser in core.

Reasons:

- language support expands the dependency and maintenance surface quickly
- call resolution correctness is hard and easy to overclaim
- stale code graphs can mislead agents in safety-critical ways
- Monsthera's current value comes from durable, auditable work context, not from
  owning every code-analysis concern

Do not copy GitNexus implementation code. Treat it as product inspiration only.

## Proposed Implementation Roadmap

### Milestone 1: Code-Ref Impact

Add `CodeIntelligenceService` backed by existing repositories and
`StructureService`.

Deliverables:

- direct and prefix matching for code refs
- impact summary for a path
- changed-file impact from git diff
- MCP tools and CLI commands
- unit tests using temporary repos and synthetic work/knowledge articles

Success criteria:

- an agent can ask "what Monsthera context is affected by this changed file?"
- stale refs and active work are visible in one response
- no new runtime dependency is required

### Milestone 2: Dashboard Explorer Upgrade

Extend the existing knowledge graph page into an explorer.

Deliverables:

- code node detail panel
- owners and active work list
- filters for article/work/code/policy
- hop-depth focus
- changed-files impact panel

Success criteria:

- humans can inspect the relationship between code, work, policies, and
  knowledge without switching pages

### Milestone 3: Lightweight Inventory

Add `.monsthera/cache/code-index.json` or a Dolt-derived equivalent.

Deliverables:

- file and directory index
- language detection by extension
- conservative symbol extraction for TypeScript first
- code inventory status in `monsthera status`
- `code_query` over inventory and article context

Success criteria:

- agents can discover likely files/symbols before falling back to `rg`
- inventory staleness is obvious and recoverable

### Milestone 4: Provider Bridge

Add the `CodeGraphProvider` abstraction.

Deliverables:

- config for provider mode and endpoint
- provider status surfaced in MCP/dashboard
- stable `code_context`, `code_impact`, and `detect_code_changes` tools
- external provider adapter behind optional config

Success criteria:

- Monsthera can consume advanced code graph intelligence without becoming
  responsible for every parser and graph algorithm

### Milestone 5: Policy Integration

Let policy articles require code-intelligence checks.

Examples:

- "Before review, any work touching auth files must run code impact."
- "If `detect_changed_code_refs` finds policies linked to changed files, require
  architecture/security enrichment."
- "If a code provider reports high impact, require two reviewers."

This turns code intelligence into orchestration control, not just read-only
search.

## Resolved Decisions

The following questions were open in the original draft and were settled by
the Milestone 1 and Milestone 2 implementations.

- **Path matching:** Layer 1 supports exact match and directory-prefix match
  only. Glob-style code refs are out of scope; clients that need glob behavior
  should expand globs before passing paths to the tool.
- **Changed-file detection source:** the MCP server does not shell out to git.
  `code_detect_changes` accepts a `changed_paths` array supplied by the
  client/harness (typically captured via `git diff --name-only` in a CLI
  wrapper). This keeps the MCP boundary deterministic and side-effect-free.
- **CLI placement:** shipped in Milestone 2 as `monsthera code ref/owners/impact/changes`.
  The `code changes` subcommand bridges git into the MCP contract by capturing
  `git diff --name-only` (or `--cached`, or `<base>...HEAD`) and passing the
  result to `detectChangedCodeRefs`. Default mode is `HEAD`; `--staged` matches
  what a pre-commit hook sees; `--base <ref>` covers review-bot scenarios.
  Output is JSON-only on stdout (consistent with `monsthera convoy` and
  `monsthera events`).
- **High-risk signal as orchestration event (M2):** when
  `analyzeCodeRefImpact` or `detectChangedCodeRefs` produces `risk: high`
  against an active work article, `CodeIntelligenceService` emits a
  `code_high_risk_detected` orchestration event. The envelope's `workId` is
  the active work article; `details` carries the normalized path, source
  (`analyze_impact` | `detect_changes`), reasons, counts, and a timestamp.
  The event is **internal-only** — listed in `INTERNAL_ONLY_EVENT_TYPES` so
  external `events_emit` callers cannot fabricate it. M2 only emits; M5 will
  let policy articles subscribe and gate phase advancement on it. When risk
  is high but no active work is linked (e.g. policy-only or missing-file
  cases), the signal stays in the response payload but no event is emitted —
  there is no `workId` for the orchestration layer to address.
- **Dashboard explorer scope (M2):** Milestone 2 ships a standalone `/code`
  page with two interaction modes (single-path inspect + diff-paths detect)
  and a `Code` sidebar entry. The earlier ADR vision of "filter the
  knowledge graph by article/work/code/policy" was deliberately punted to a
  future Milestone — extending the existing knowledge-graph page would
  require reshaping its filter model and tab semantics, which exceeds M2
  scope. The standalone page covers the M2 success criterion ("humans can
  inspect the relationship between code, work, policies, and knowledge")
  without forcing a graph redesign.

## Open Questions

- Should code inventory live only in `.monsthera/cache/`, or also in Dolt when
  Dolt is enabled?
- Should `code_query` be a new tool group, or should it enrich
  `build_context_pack` first?
- How much next-step guidance should be appended to MCP responses before it
  becomes noisy?

## Consequences

Positive:

- Agents get code-change safety checks without losing Monsthera's durable memory
  model.
- The first milestone is implementable with today's architecture.
- Advanced code graphs remain possible through providers.
- Dashboard graph work becomes directly useful for code review and planning.

Negative:

- More MCP tools can increase choice overload unless guidance is designed well.
- Lightweight inventory may be mistaken for full static analysis unless
  capability markers are explicit.
- Provider mode introduces integration and staleness states that must be visible
  in status and dashboard surfaces.

## Summary

Monsthera should become code-intelligent by making code part of its operational
memory first, then by adding optional code graph depth. The near-term product is
not "a complete AST graph." It is "agents can see which work, knowledge,
policies, and handoffs are affected by the code they are about to change."

