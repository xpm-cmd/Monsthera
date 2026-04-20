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