---
id: k-fqn5b57c
title: CLI entrypoint and command routing
slug: cli-entrypoint-and-command-routing
category: context
tags: [cli, entrypoint, routing, commands, operators]
codeRefs: [src/bin.ts, src/cli/main.ts, src/cli/arg-helpers.ts, src/cli/formatters.ts, src/cli/knowledge-commands.ts, src/cli/work-commands.ts, src/cli/ingest-commands.ts, src/cli/doctor-commands.ts, src/cli/index.ts]
references: [adr-005-surface-boundaries, mcp-tool-catalog-complete-reference, monsthera-ingest-service-for-local-file-import]
createdAt: 2026-04-18T07:40:30.820Z
updatedAt: 2026-04-18T07:40:30.820Z
---

## Overview

The CLI surface is the thinnest operational wrapper around the Monsthera container. `src/bin.ts` does almost nothing beyond importing `main()`, while `src/cli/main.ts` owns command dispatch, help text, and the policy for when commands bootstrap a full container.

This surface complements [[adr-005-surface-boundaries]]: the CLI is not a second implementation of Monsthera, it is a user-facing router over the same services that power the MCP server and the dashboard.

## Entry path

- `src/bin.ts` imports `main` from `src/cli/main.ts` and forwards `process.argv.slice(2)`.
- `main()` switches on the first token and routes to command handlers such as `serve`, `dashboard`, `status`, `knowledge`, `work`, `ingest`, `search`, `reindex`, `migrate`, and `doctor`.
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
- `ingest-commands.ts` wraps local-source import
- `doctor-commands.ts` is the heavy diagnostics surface
- `formatters.ts` keeps human-readable output separate from domain logic

This means the CLI is effectively an adapter layer. It should stay boring: parse arguments, call services, format output, exit with the right code.

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