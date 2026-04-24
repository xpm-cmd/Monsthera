# ADR-010: Orchestrator Ergonomics & Audit Tooling (PR A)

**Status:** Accepted
**Date:** 2026-04-24
**Decision makers:** Architecture team

## Context

ADR-007 added knowledge-driven policies: a Markdown file can gate work-article transitions. The field review of the resulting orchestrator flagged two operational gaps that are independent of orchestration correctness but matter for day-one ergonomics:

1. **Canonical-value drift.** The corpus contains numerics and monetary amounts (`c_rt = $0.010`, `K_min = $1,815`) that auditors agree on by name. When a figure changes in one article but not another, silent drift creeps in. Wave-2 cut a review where the same cost figure appeared as `$0.010` and `$0.10` across sibling articles — both valid-looking to a reader who does not know which one is canonical.
2. **Orphan citations.** Articles cite each other by `k-xxx` / `w-xxx` id both in the frontmatter `references` array and inline in prose. When a citation target is renamed, deleted, or simply mistyped, the reference silently dangles. The existing `StructureService.getGraph()` already tracks a `missingReferences` gap set but does not surface it as a first-class auditable list.

Session 4 of the 4-session orchestration plan groups these with three more CLI-ergonomics items (`work list` filters, `work advance` output, structured `phase_history` metadata). Per the plan note, this ADR and its PR cover only the first two — the "audit tooling" half — and are intentionally split from the CLI ergonomics half to keep the PR reviewable. ADR-011 will document the deferred parts.

## Decision

Ship two new capabilities behind a single CLI command and four new MCP tools:

- `monsthera lint` (+ `lint_corpus` MCP tool) emits NDJSON findings for canonical-value drift and orphan citations. Drift is an error (exit 1); orphans are warnings (exit 0 preserved).
- `monsthera knowledge refs (--to | --from | --orphans)` (+ `refs_incoming`, `refs_outgoing`, `refs_orphans` MCP tools) returns the full, unbounded reference-graph edge set around an article, or the orphan list across the corpus.

### Canonical-values encoding

A canonical-value registry is an array of entries, each shaped roughly:

```json
{
  "name": "c_rt",
  "value": "$0.010",
  "unit": "per_rt",
  "source_article": "k-aristotle-c2-cpcv",
  "valid_since_commit": "8012863",
  "rationale": "Corrected from $0.10 in Wave-2 boundary review"
}
```

The registry is carried inside any `category: policy` article via a flat frontmatter field named `policy_canonical_values_json` whose value is the JSON-encoded array. Multiple policy articles may each carry their own slice; `PolicyLoader.getCanonicalValues()` aggregates across them, first-wins on name collisions.

Alternatives considered:

- **Nested YAML (`values: [{ name, value, ... }, ...]`).** This is the shape the session-4 prompt sketched. Rejected: the flat markdown parser at `src/knowledge/markdown.ts:16` splits any `[...]`-wrapped frontmatter value by commas, so a JSON/YAML array containing object literals round-trips as a list of corrupted fragments. Expanding the parser is out of scope here and was previously deferred by ADR-007; until that expansion happens, a JSON string inside a single flat field is the honest encoding.
- **Parallel arrays (`canonical_value_names: [...]; canonical_value_values: [...]; ...`).** Rejected: alignment is brittle and easy to break in code review. A single structured JSON blob is easier to author correctly, easier to diff, and matches how `extraFrontmatter` carries other policy fields.
- **A dedicated DSL file (`canonical-values.yaml` outside `knowledge/`).** Rejected for the same reason ADR-007 rejected a policies DSL: these values *are* knowledge, the prose that justifies them belongs next to the data, and two stores diverge. The registry lives in the same wiki as the articles that use the values.

Value comparison uses raw-string normalisation (`strip $`, `strip ,`, `strip whitespace`) rather than numeric parsing. `0.010` vs `0.01` is exactly the kind of drift auditors want flagged; `Number("0.010") === Number("0.01")` would hide it.

### Ref graph surface

Two methods on `StructureService`:

- `getRefGraph(idOrSlug)` — unbounded edge set for a single article, filtered to `kind: reference` edges and `knowledge | work` neighbors. Parallel to the capped-at-10 `connections` block that `get_article` exposes, but designed for audit rather than browsing.
- `getOrphanCitations()` — walks the existing `missingReferences` gap set that `getGraph()` already computes and attaches a markdown-root-relative source path (`notes/<slug>.md` for knowledge, `work-articles/<id>.md` for work).

The widening that makes this work: `StructureService.getGraph()` previously collected references from `article.references` + `[[wikilink]]` slugs. It now additionally unions inline `k-*` / `w-*` ids parsed from prose via a new `extractInlineArticleIds()` helper in `src/structure/wikilink.ts`. Code regions (fenced blocks, inline code, HTML comments) are stripped first using the same `stripCodeRegions` helper that protects wikilinks, so example ids inside snippets do not leak into the graph. Self-references are filtered out during collection.

Alternative considered: a dedicated `RefGraphService` class. Rejected: the reference graph is the same graph `StructureService.getGraph()` already builds; duplicating traversal would let the two services drift. The two new methods on `StructureService` are thin projections over data the service already has, not a parallel implementation.

### Lint surface

The CLI emits NDJSON on stdout by default (one finding per line), or a human table with `--format text`. Logs go to stderr through the shared logger, preserving the `cli-stream-separation.test.ts` contract. Exit code 1 when any `severity: error` finding is emitted; warnings (orphan citations) do not affect exit code so CI pipelines stay green on soft signals.

`LintFinding` is a discriminated union on `rule`:

- `canonical_value_mismatch` — `{ name, expected, found, lineHint, sinceCommit? }`, `severity: "error"`
- `orphan_citation` — `{ sourceArticleId, missingRefId }`, `severity: "warning"`

Future rules (e.g. `stale_code_ref`) slot in the same shape.

## Consequences

### Positive

- Teams can author a canonical-value registry as a `.md` file and catch drift via `monsthera lint` without writing TypeScript — matches ADR-007's goal of pushing rules into knowledge rather than code.
- Orphan detection is now a first-class audit surface rather than a summary counter. `refs_orphans` gives an agent a direct follow-up action.
- The widened ref collection means `get_article.connections.referencedBy`, `getGraph()`, and `refs_incoming` all see the same citations — inline `k-*` ids in prose are no longer invisible.
- The split from PR B keeps reviewability under 1h per PR, per the S4 prompt's own guidance.

### Negative

- The flat JSON-string encoding for `policy_canonical_values_json` is awkward to author by hand relative to native YAML. AGENTS.md documents the shape; authors who edit it by hand need to keep the outer single quotes and valid JSON inside. A future parser expansion lifts this restriction.
- `extractInlineArticleIds` is heuristic — `\b[kw]-[a-z0-9]+(-[a-z0-9]+)*\b` — and treats any matching token as a citation. A prose passage that happens to say `k-nearest-neighbor` (an algorithm name) would register as an inline citation to an id that does not exist, yielding a spurious `orphan_citation` warning. This is acceptable for an audit signal but something authors should be aware of.
- The lint CLI constructs its own `PolicyLoader` rather than reading one off the container. Cheap (it's a single repo call) but means canonical-values cache is not shared with the orchestrator's loader. A future change may unify them.

### Neutral

- The ref-graph surface is unbounded by design — a hub article with thousands of incoming citations returns all of them. Callers that want a capped browse-friendly view should keep using `get_article.connections`.
- `ADR-008` and `ADR-009` are reserved for the remaining 4-session work (S2 agent dispatch, S3 convoys/requires-chain). This ADR uses `ADR-010` to match the session-4 prompt's declared number; ADR-011 will document PR B.

## Implementation Notes

- Canonical-values schema: `CanonicalValueSchema` in [src/work/policy-loader.ts](src/work/policy-loader.ts), loaded via `PolicyLoader.getCanonicalValues()`.
- Guard + violations helper: `content_matches_canonical_values`, `getCanonicalValueViolations` in [src/work/guards.ts](src/work/guards.ts).
- Lint scanner: `scanCorpus` in [src/work/lint.ts](src/work/lint.ts) — pure, accepts pre-computed orphan findings.
- Lint CLI: [src/cli/lint-commands.ts](src/cli/lint-commands.ts); MCP tool: [src/tools/lint-tools.ts](src/tools/lint-tools.ts).
- Inline-id extractor: `extractInlineArticleIds` in [src/structure/wikilink.ts](src/structure/wikilink.ts).
- Ref-graph methods: `getRefGraph`, `getOrphanCitations` in [src/structure/service.ts](src/structure/service.ts).
- Refs CLI: subcommand `refs` under [src/cli/knowledge-commands.ts](src/cli/knowledge-commands.ts); MCP tool: [src/tools/refs-tools.ts](src/tools/refs-tools.ts).
- Seed registry: [knowledge/notes/canonical-values.md](../../knowledge/notes/canonical-values.md) — empty array, documentation-only. Downstream repos populate.
