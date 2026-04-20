---
id: k-fqn5b57c
title: CLI entrypoint and command routing
slug: cli-entrypoint-and-command-routing
category: context
tags: [cli, entrypoint, routing, commands, operators]
codeRefs: [src/bin.ts, src/cli/main.ts, src/cli/arg-helpers.ts, src/cli/formatters.ts, src/cli/knowledge-commands.ts, src/cli/work-commands.ts, src/cli/context-commands.ts, src/cli/ingest-commands.ts, src/cli/doctor-commands.ts, src/cli/index.ts]
references: [adr-005-surface-boundaries, mcp-tool-catalog-complete-reference, monsthera-ingest-service-for-local-file-import]
createdAt: 2026-04-18T07:40:30.820Z
updatedAt: 2026-04-20T00:00:00.000Z
---

## Overview

The CLI surface is the thinnest operational wrapper around the Monsthera container. `src/bin.ts` does almost nothing beyond importing `main()`, while `src/cli/main.ts` owns command dispatch, help text, and the policy for when commands bootstrap a full container.

This surface complements [[adr-005-surface-boundaries]]: the CLI is not a second implementation of Monsthera, it is a user-facing router over the same services that power the MCP server and the dashboard.

## Entry path

- `src/bin.ts` imports `main` from `src/cli/main.ts` and forwards `process.argv.slice(2)`.
- `main()` switches on the first token and routes to command handlers such as `serve`, `dashboard`, `status`, `knowledge`, `work`, `ingest`, `search`, `pack`, `reindex`, `migrate`, and `doctor`.
- Unknown commands and explicit `--help`/`--version` are handled at the top level.

## Container boot policy

The CLI uses two boot patterns:

- direct boot in top-level handlers like `serve`, `dashboard`, and `migrate`
- `withContainer()` in `arg-helpers.ts` for subcommands that need a disposable runtime wrapper

`withContainer()` centralizes repo-path parsing, config loading, container lifecycle, and disposal. That keeps command modules small and ensures even read-only operations use the same wiring as the real server.

## Command modules

The split across files is intentional:

- `knowledge-commands.ts` maps CLI flags into `KnowledgeService`
- `work-commands.ts` maps lifecycle operations into `WorkService`
- `context-commands.ts` owns the `pack` command — end-to-end `build_context_pack`, with optional snapshot recording via the same `SnapshotService` the MCP server uses
- `ingest-commands.ts` wraps local-source import
- `doctor-commands.ts` is the heavy diagnostics surface
- `formatters.ts` keeps human-readable output separate from domain logic

This means the CLI is effectively an adapter layer. It should stay boring: parse arguments, call services, format output, exit with the right code.

## `monsthera pack` — context packs from the shell

`monsthera pack <query...>` builds a ranked context pack end-to-end from the CLI, replacing the ad-hoc `scripts/probe.ts` pattern used during Tier 5 sessions. It reuses `handleSearchTool("build_context_pack", ...)` so behaviour matches the MCP server exactly.

Supported flags (see `src/cli/context-commands.ts`):

- `--mode general|code|research` — ranking / diagnostics profile
- `--type knowledge|work|all` — scope
- `--limit N` — cap item count
- `--agent-id A` / `--work-id W` — attach identity so the snapshot block in the response is filtered to the right agent/work
- `--include-content` — return full article content, not just snippets
- `--verbose` — emit full quality/freshness diagnostics
- `--json` — machine-readable output
- `--record <path>` or `--record -` — read a snapshot JSON payload (from disk or stdin) and call `snapshotService.record` before building the pack. The recorded snapshot id is echoed in the response. This makes `capture-env-snapshot.ts | monsthera pack ... --record -` a one-liner for the three-step runbook.

## `monsthera work close` — audited review-to-done bypass

`monsthera work close <id> (--pr <n> | --reason <text>)` is the sanctioned bypass of the `review -> done` transition. It calls `advancePhase(id, DONE, { skipGuard: { reason } })`, which records the guard name and reason on the `phase_history` entry — the audit trail survives. Passing `--pr 42` synthesizes a standard reason (`"merged via PR #42; no external reviewer — bypass recorded on phase history"`), `--reason` lets an operator write their own. One of the two is required.

## Phase transition flags

`monsthera work advance <id> --phase <target>` supports two audit knobs:

- `--reason <text>` — free-form rationale attached to the phase-history entry
- `--skip-guard-reason <text>` — bypass the transition's guards. The skipped guard names and the reason are recorded in `phase_history[].skipped_guards` so the bypass is auditable later. This is the underlying primitive `work close` uses.

## Content-sourced work articles

`work create` and `work update` both accept the same content-input triad (resolved by `readContentInput` in `arg-helpers.ts`):

- `--content <body>` — inline string
- `--content-file <path>` — read markdown from disk
- `--edit` — open `$EDITOR` (seeded from the template for `work create`)

Only one of the three may be used per invocation.

## Machine-readable listings

Both `work list` and `knowledge list` accept `--json` to emit the raw service payload instead of the human-formatted table. This makes the CLI scriptable without having to talk to the MCP server.

## Reindex as a synchronization command

`monsthera reindex` is especially important for the wiki. It does three things together:

1. rebuilds the live search index
2. rebuilds `knowledge/index.md`
3. appends a `reindex` entry to `knowledge/log.md`

That makes the command the easiest manual "make it all mirror reality again" operation after bulk edits or imported documentation waves.

## Relationship to other surfaces

The CLI sits between two neighbors:

- the MCP tool surface documented in [[mcp-tool-catalog-complete-reference]]
- the HTTP/dashboard surface documented in [[dashboard-rest-api-endpoints]]

All three are just differently shaped entrypoints into the same container and service graph.
