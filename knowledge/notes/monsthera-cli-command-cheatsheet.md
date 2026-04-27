---
id: k-b577ihrv
title: Monsthera CLI Command Cheatsheet
slug: monsthera-cli-command-cheatsheet
category: reference
tags: [cli, reference, cheatsheet, work-close, pack, content-file]
codeRefs: []
references: []
createdAt: 2026-04-20T00:26:39.087Z
updatedAt: 2026-04-20T00:26:39.087Z
---

# Monsthera CLI Command Cheatsheet

Complete reference for the `monsthera` CLI surface. Use this when you need the exact flag syntax for any subcommand — every command below has been confirmed against `src/cli/` as of release `3.0.0-alpha.6`.

## Quick reference

| Goal | Command |
| :-- | :-- |
| Start the MCP server | `monsthera serve` |
| Start the HTTP dashboard | `monsthera dashboard [--port <n>]` |
| Print system status as JSON | `monsthera status` |
| Print the version | `monsthera --version` / `-v` |
| Search across all articles | `monsthera search <query> [--type knowledge\|work\|all] [--limit N]` |
| Build a ranked context pack | `monsthera pack <query...>` |
| Inspect a code path's Monsthera footprint | `monsthera code ref <path>` |
| Find the owners of a code path | `monsthera code owners <path>` |
| Score the impact of touching a path | `monsthera code impact <path>` |
| Detect impact across a git diff | `monsthera code changes [--staged \| --base <ref>]` |
| Rebuild the search index | `monsthera reindex` |
| Run health checks | `monsthera doctor` |

All commands accept `--repo <path>` / `-r <path>` to point at a repository other than the current working directory.

## `knowledge` — knowledge articles

```sh
monsthera knowledge create --title <t> --category <c> --content <body> [--tags t1,t2] [--code-refs r1,r2]
monsthera knowledge get     <id-or-slug>
monsthera knowledge list    [--category <c>] [--json]
monsthera knowledge update  <id> [--title <t>] [--category <c>] [--content <body>] [--tags t1,t2]
monsthera knowledge delete  <id>
```

- `--json` on `list` emits `JSON.stringify(result.value, null, 2)` so agents can parse the array without re-querying via MCP.
- `create` / `update` only accept `--content <body>` inline; for long markdown with backticks or multiline blocks, prefer `work`'s `--content-file` pattern — the `knowledge` commands do not yet have a `--content-file` flag (opportunity for a follow-up PR).

## `work` — work articles

```sh
monsthera work create   --title <t> --template <template> --author <a> [--priority <p>] [--tags t1,t2]
                        [--content <body> | --content-file <path> | --edit]
monsthera work get      <id>
monsthera work list     [--phase <p>] [--json]
monsthera work update   <id> [--title <t>] [--assignee <a>] [--priority <p>] [--tags t1,t2]
                        [--content <body> | --content-file <path> | --edit]
monsthera work advance  <id> --phase <target> [--reason <text>] [--skip-guard-reason <text>]
monsthera work close    <id> (--pr <n> | --reason <text>)
monsthera work enrich   <id> --role <role> --status <contributed|skipped>
monsthera work review   <id> --reviewer <agent-id> --status <approved|changes-requested>
monsthera work delete   <id>
```

### Content input (`create` and `update`)

Three mutually exclusive modes:

- `--content <body>`: literal body on the command line. **Avoid** for markdown bodies with backticks — shell heredoc quoting (`--content "$(cat <<'EOF' ... EOF)"`) corrupts them to `\\\`foo\\\``.
- `--content-file <path>`: read the body verbatim from disk. The correct default for any nontrivial body. Introduced in release `3.0.0-alpha.6`.
- `--edit`: open `$EDITOR` (or `$VISUAL`) on a scratch file. For `work create` the buffer is seeded with `generateInitialContent(template)` — the required section headings for the chosen template. Introduced in release `3.0.0-alpha.6`.

Passing two of the three at once exits 1 with `"--content, --content-file, and --edit are mutually exclusive"`.

### Closing a merged work article

`work close <id>` is the canonical way to advance `review → done` when the article shipped via a PR and no external reviewer is available. Exactly one of `--pr` or `--reason` must be set.

```sh
# Canonical close-out after a PR merge:
monsthera work close w-abc123 --pr 42

# Custom reason (e.g. abandoned mid-review with audit trail):
monsthera work close w-abc123 --reason "deferred to Tier 7; picked up in w-def456"

# `#`-prefixed PR numbers are normalised:
monsthera work close w-abc123 --pr "#42"   # records "merged via PR #42; no external reviewer — bypass recorded on phase history"
```

Under the hood this is `advancePhase(id, DONE, { skipGuard: { reason } })` — identical audit trail to every other `skipGuard` bypass. Introduced in release `3.0.0-alpha.6` (replaces the `work advance <id> --phase done --skip-guard-reason "..."` four-flag incantation that was typed six times during the Tier 5 close-out).

### Advancing through other phases

`work advance` handles every other transition. `--reason` is **required** when advancing to `cancelled` (audit-trail contract, Tier 2.1). `--skip-guard-reason` bypasses a failing async guard (e.g. `snapshot_ready` on `enrichment → implementation`) with an auditable justification.

```sh
monsthera work advance w-abc123 --phase enrichment
monsthera work advance w-abc123 --phase implementation --skip-guard-reason "no lockfile drift; trust ADR-006 fast path"
monsthera work advance w-abc123 --phase cancelled --reason "superseded by w-def456"
```

## `ingest` — import external sources

```sh
monsthera ingest local --path <file-or-dir> [--category <c>] [--tags t1,t2] [--code-refs r1,r2]
                       [--summary] [--no-recursive] [--no-replace]
```

`--summary` emits a per-file summary on stdout. `--no-recursive` stops directory traversal at the top level. `--no-replace` skips existing articles with the same source path instead of overwriting.

## `search` — quick keyword lookup

```sh
monsthera search <query> [--type knowledge|work|all] [--limit N]
```

BM25 keyword ranking. Best with 1–3 specific terms (AND semantics). For deep investigation use `pack` instead — it combines search with freshness, quality, and code-link signals.

## `pack` — ranked context pack with optional snapshot

```sh
monsthera pack <query...> [--mode general|code|research] [--limit N]
                          [--type knowledge|work|all]
                          [--agent-id <a>] [--work-id <w>]
                          [--include-content] [--verbose] [--json]
                          [--record <path>|-]
```

End-to-end `build_context_pack` from the CLI. Introduced in release `3.0.0-alpha.6`; reuses the same `handleSearchTool("build_context_pack", ...)` dispatcher the MCP server uses, so behaviour is identical across surfaces.

- `--record <path>` reads a snapshot JSON (format: `scripts/capture-env-snapshot.ts` output) and records it before building the pack.
- `--record -` reads snapshot JSON from stdin — pipe directly from the capture helper:
  ```sh
  pnpm exec tsx scripts/capture-env-snapshot.ts --agent-id a-1 --work-id w-abc \
    | monsthera pack "token use" --record - --work-id w-abc
  ```
- `--json` emits the full pack (including `recordedSnapshotId` when `--record` was used). Default is a short human render of the top items + snapshot summary.

### When to use `pack` vs `search` vs direct `grep`

A real observational benchmark (work article `w-benchmark-1`, sibling of this note) compared five retrieval paths for two kinds of queries:

| Query kind | Fastest useful answer |
| :-- | :-- |
| "How does the `snapshot_ready` guard work?" | `pack --include-content` — returns 3 ranked articles with full body in one call |
| "What is the exact flag syntax for `work close`?" | `grep` on `src/cli/` — 100 ms, verbatim |
| "Which ADR explains decision X?" | `search` — BM25 finds the ADR by title, follow up with `get_article` |
| "Which work articles touch `src/context/`?" | `list_work --tag snapshot --json` or MCP `search` with `type=work` |

Grep wins on verbatim-string queries; `pack` wins on narrative/conceptual queries. The knowledge base complements grep — it does not replace it.

## `code` — code-ref intelligence (ADR-015 Layer 1)

```sh
monsthera code ref     <path>
monsthera code owners  <path>
monsthera code impact  <path>
monsthera code changes [--staged | --base <ref>] [--repo <path>]
```

Ships in release `3.0.0-alpha.7` (Milestone 2). All four subcommands are
thin CLI wrappers around `CodeIntelligenceService`, the same service that
backs the `code_get_ref` / `code_find_owners` / `code_analyze_impact` /
`code_detect_changes` MCP tools. Output is one JSON record per command on
stdout — pipe into `jq` for filtering. Logs stay on stderr.

| Subcommand | When to use |
| :-- | :-- |
| `ref` | "Tell me everything Monsthera knows about this path" — existence, line anchor, owners, active work, policies, summary counts. |
| `owners` | "Who is on this path?" — knowledge + work owners, no filesystem stat, no risk scoring. Faster than `impact` when ownership is all you need. |
| `impact` | "Should I touch this?" — risk (`none|low|medium|high`), reasons (`active_work_linked`, `policy_linked`, `code_ref_missing`, `no_monsthera_context`, etc.), and recommended next actions. The right call before editing or reviewing a path. |
| `changes` | "What does this diff disturb?" — captures `git diff --name-only` and feeds the result to `detectChangedCodeRefs`. Default mode is `HEAD` (staged + unstaged); `--staged` narrows to the index (matches a pre-commit hook); `--base <ref>` diffs `<ref>...HEAD` for review-bot use. |

### Why `code changes` shells out to git, but the MCP tool does not

ADR-015 *Resolved Decisions* keeps the MCP boundary side-effect-free:
`code_detect_changes` accepts a pre-computed `changed_paths` array. The
CLI is the right surface to bridge git into that contract because it
already runs in the operator's working tree with their credentials and
their `git` config. An empty diff produces a zero-impact payload
(`changedPathCount: 0`), not an error — useful for pre-commit hooks that
run unconditionally.

```sh
# Before editing — see if you'd disturb anything Monsthera tracks:
monsthera code impact src/auth/session.ts | jq '.risk, .reasons'

# Before review — what does the staged diff hit?
monsthera code changes --staged | jq '.summary'

# In CI — score a feature branch against main:
monsthera code changes --base origin/main | jq '.summary.highestRisk'
```

### What `risk: high` actually triggers

When `analyzeCodeRefImpact` or `detectChangedCodeRefs` produces
`risk: "high"` against an active work article, the service emits a
`code_high_risk_detected` orchestration event (envelope `workId` is the
active work, `details` carries `normalizedPath`, `source`, `reasons`,
counts, and `detectedAt`). The event is internal-only — external
`events_emit` callers cannot fabricate it. M2 only emits; ADR-015 M5
will let policy articles subscribe and gate phase advancement on it.

## `reindex` — rebuild the search index

```sh
monsthera reindex
```

Full BM25 + embedding rebuild from the markdown corpus. Rebuilds `knowledge/index.md` alongside. Use only after bulk imports, migrations, or recovery work — normal CRUD flows keep the index in sync automatically.

## `migrate` — v2 → v3 migration

```sh
monsthera migrate [--mode dry-run|validate|execute] [--scope work|knowledge|all]
                  [--source <sqlite-path>] [--force] [--json]
```

Reads a legacy v2 SQLite database (default: `.monsthera/monsthera.db`) and imports tickets / verdicts / assignments / knowledge / notes into the v3 markdown corpus.

## `doctor` — health checks

```sh
monsthera doctor
```

Diagnostic readout across config, markdown root, knowledge repo, work repo, search index, optional Dolt pool, and optional Ollama embedding provider. Exits 0 when every subsystem is healthy.

## Common flags shared by every `withContainer` subcommand

- `--repo <path>` / `-r <path>` — repository path. Defaults to `process.cwd()`. `knowledge`, `work`, `ingest`, `search`, `pack`, `reindex`, `migrate`, `doctor`, and `status` all honour it.
- `--version` / `-v` — print the version and exit.
- `--help` / `-h` — print the top-level usage summary.

## Links

- `k-to46fuoi` — IRIS Meta-Harness research note (indexes all follow-up tiers, including the Tier 6 CLI UX work).
- `k-pwksnl38` — formal benchmark methodology for the snapshot + `build_context_pack` surface.
- `k-uuz80fga` — agent operating guide with the 3-step snapshot runbook.
- `CHANGELOG.md` `[3.0.0-alpha.6]` — Tier 6 release notes with the PRs that shipped every command introduced above.