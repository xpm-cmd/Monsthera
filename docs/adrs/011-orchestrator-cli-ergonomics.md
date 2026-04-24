# ADR-011: Orchestrator CLI Ergonomics (PR B)

**Status:** Accepted
**Date:** 2026-04-24
**Decision makers:** Architecture team

## Context

ADR-010 shipped the audit-tooling half of S4 (canonical-values lint, ref graph queries). The other three parts of the S4 prompt — `work list` filters, `work advance` clean output, and structured `phase_history` metadata — are orthogonal CLI/UX concerns. They travel together because each one helps agents and humans filter, script, and audit the orchestrator's per-phase record without needing to parse fixed-width tables or stuff everything into free-text `--reason` strings.

Field feedback on the pre-PR-B CLI:

- `monsthera work list` had a single `--phase` filter and a single `--json` flag. Scripts that wanted "articles in wave 3 whose enrichment phase is older than 2 days" had to pull the whole list and filter client-side.
- `monsthera work advance` always dumped a ~20-line full-article block on stdout. CI jobs and chained agents parsed the block with regex to extract `Phase:` and called it done — a brittle contract.
- `--reason "Wave-3 Chunk-3A: success_test=Y blockers=0 verdicts=[adopt-v1,monitor]"` was the actual norm. Structured data encoded as ad-hoc prose. Querying it post-hoc required grep.

## Decision

Three co-ordinated changes, back-compatible across the board:

### 1. `work list` filters + format options

`monsthera work list` (and MCP `list_work`) grow four filters — `--tag`, `--wave` (shorthand for `wave-<name>` or the literal tag), `--phase-age-days`, and a metadata filter (see below) — plus a `--format table|csv|tsv|json` option. CSV/TSV are stream-friendly for spreadsheets; JSON is NDJSON of the full article shape so downstream callers can read every field without a second round-trip.

`--json` is retained as a backwards-compat alias for `--format json`, but its *shape* changed from a pretty JSON array of full articles to NDJSON of full articles. This is a deliberate alpha-era contract update — existing callers split-by-line and keep working — documented here so the change is not accidental.

The MCP `list_work` tool gains the same filters plus `metadataField`/`metadataValue` pairs. AND-combined in memory.

### 2. `work advance` clean default output

`work advance` now emits a single success line on stdout:

```
OK: w-xxx advanced planning → enrichment
reason: "<truncated to 80 chars>"         # only when a reason is set
```

Optional modes:

- `--verbose` restores the full pre-3.0 article dump.
- `--format json` emits one line of JSON: `{ workId, from, to, advancedAt, reason? }`.
- `--verbose` and `--format json` are mutually exclusive (rejected with a readable error).

The `from` phase is captured via a `getWork` round-trip before the advance, not inferred from `phaseHistory`, because a cancellation or skip-guard advance may break the naive "previous → current" invariant and inference would be fragile.

### 3. Structured `phase_history.metadata`

`PhaseHistoryEntry` gains an optional `metadata?: Readonly<Record<string, unknown>>` field that persists verbatim on the new entry at advance time. The shape is deliberately open so downstream repos can add fields without schema churn; five conventional keys are reserved and surfaced by CLI flags:

- `success_test: "Y" | "N" | "skipped"` (`--success-test`)
- `blockers: number` (`--blockers`, non-negative integer)
- `fabrications: number` (`--fabrications`, non-negative integer)
- `verify_count: number` (`--verify-count`, non-negative integer)
- `verdicts: string[]` (`--verdicts`, comma-separated)

Plus an escape hatch: `--metadata-json '<json-object>'`. Convention flags are merged last and win on key collision, so `--blockers 0 --metadata-json '{"blockers": 99, "notes": "ok"}'` yields `{ blockers: 0, notes: "ok" }`.

The MCP `advance_phase` tool grows a parallel `metadata` parameter. Two query entry points let callers exploit the structure:

- `monsthera work list --metadata-filter field=value` + MCP `list_work` with `metadataField` / `metadataValue` pairs (AND-combined with the other filters).
- MCP `search_work_by_metadata({ field, value })` for the single-filter case.

Matching is strict equality for scalars and inclusion for array-valued fields (so `--metadata-filter verdicts=adopt-v1` hits `verdicts: ["adopt-v1", "monitor"]`). "Any phase-history entry" matches — not just the latest — because the typical question is "did this article ever carry X?", not "what's its current state?".

Serialization piggybacks on the existing `phaseHistoryJson` JSON-string frontmatter field that `FileSystemWorkArticleRepository` already writes — no schema or parser change was needed.

## Alternatives considered

- **Split across three PRs (one per change).** Rejected: the three concerns all touch `src/cli/work-commands.ts` and share the NDJSON shape decision; keeping them in one PR meant one test update pass, not three. Each change is its own commit for bisectability.
- **Keep `--json` emitting a pretty array for back-compat, add `--format json` as NDJSON.** Rejected: two JSON shapes on the same command is exactly the kind of "silent contract drift" the S4 prompt flagged. Aligning `--json` as an alias for `--format json` is a cleaner invariant; existing callers update their parsing once.
- **Dedicated `metadata` top-level frontmatter field (nested YAML).** Rejected: same flat-parser constraint that drove ADR-007 and ADR-010 flat-keys decisions. The JSON-string path already handles arbitrary shapes inside `phaseHistoryJson`, so no change in transport was needed.
- **Enforce a Zod schema for `metadata`.** Rejected: prescriptiveness belongs in documentation, not the transport. Downstream repos invent their own conventional keys; Monsthera validates the conventional-flag inputs (`success_test` values, non-negative integers) at the CLI boundary but accepts any object through the `--metadata-json` / MCP `metadata` escape hatch.

## Consequences

### Positive

- Scripts and chained agents can filter and consume work articles as NDJSON / CSV / TSV without regex parsing table output.
- Structured `phase_history.metadata` makes "which articles failed success_test" / "which articles have ≥ 1 blocker" / "which articles got the adopt-v1 verdict" directly queryable.
- `work advance` stops dumping 20-line blobs on routine calls; logs still land on stderr through the shared logger, pipelines stay clean.
- Back-compat: existing `phaseHistory` entries without `metadata` keep parsing; `--json` still works (with the documented shape change); `--verbose` preserves the old output.

### Negative

- `--json` shape change (pretty array → NDJSON) is a breaking contract for anyone who was parsing the whole stdout as one `JSON.parse()`. Migration is one-line (split by `\n`, parse each). Documented here and in AGENTS.md.
- The metadata shape is a convention, not a schema. Typos in keys (`success_test` vs `sucess_test`) silently yield separate columns in query results. A future session could add a registry + lint rule if drift becomes an operational issue.
- The metadata filter matches "any phase-history entry", which can surprise callers expecting "latest only". Documented at the CLI flag help and in the MCP tool description.

### Neutral

- `--verbose` on `work advance` is now opt-in. Any human run that wanted the full dump needs to add the flag.
- `advance_phase` MCP tool surface grows by one optional argument (`metadata`); existing callers pass nothing and behavior is unchanged.

## Implementation Notes

- `PhaseHistoryEntry.metadata` — [src/work/repository.ts](src/work/repository.ts).
- `AdvancePhaseOptions.metadata` — same file; threaded through [src/work/phase-history.ts](src/work/phase-history.ts) builders with defensive copy.
- Frontmatter round-trip: file-repository reads metadata off `phaseHistoryJson`; write path serializes the full `article.phaseHistory` array via `JSON.stringify`, so no separate write change was needed — [src/work/file-repository.ts](src/work/file-repository.ts).
- CLI: `work list` filters + formats and `work advance` clean output + structured flags — [src/cli/work-commands.ts](src/cli/work-commands.ts).
- MCP: `list_work` filters + `advance_phase` metadata + new `search_work_by_metadata` tool — [src/tools/work-tools.ts](src/tools/work-tools.ts).
- AGENTS.md gets a "Structured reason fields convention" section that names the conventional keys and the flag-over-free-text preference.
