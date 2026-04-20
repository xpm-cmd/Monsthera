---
id: k-8dsb3up8
title: ADR-005: Surface Boundaries
slug: adr-005-surface-boundaries
category: architecture
tags: [mcp, cli, dashboard, tools, api-surface, validation, adr, architecture]
codeRefs: [src/server.ts, src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/tools/search-tools.ts, src/tools/orchestration-tools.ts, src/tools/status-tools.ts, src/tools/ingest-tools.ts, src/tools/structure-tools.ts, src/tools/validation.ts, src/cli/main.ts, src/cli/knowledge-commands.ts, src/cli/work-commands.ts, src/cli/doctor-commands.ts, src/dashboard/index.ts, src/dashboard/auth.ts, src/bin.ts, src/tools/agent-tools.ts, src/tools/wave-tools.ts, src/tools/wiki-tools.ts, src/tools/snapshot-tools.ts, src/tools/index.ts]
references: [cli-entrypoint-and-command-routing, package-entrypoints-and-barrel-exports, wiki-surfaces-and-wikilink-semantics, agent-and-wave-mcp-tools]
sourcePath: docs/adrs/005-surface-boundaries.md
createdAt: 2026-04-10T23:03:46.549Z
updatedAt: 2026-04-20T00:00:00.000Z
---

## Status
Accepted — 2026-04-07

## Decision
Monsthera exposes three distinct surfaces. All three share the same `MonstheraContainer` and its services (knowledge, work, search, orchestration, ingest, structure, agents, status). The container is the single composition root; surfaces are thin adapters over it.

---

## Surface 1: MCP Server (stdio)

**Transport:** stdio via `@modelcontextprotocol/sdk` `StdioServerTransport`
**Entry point:** `monsthera serve` -> `startServer(container)`
**Purpose:** Primary interface for AI coding agents (Claude Code, etc.)

Registers all tool definitions from 11 tool modules (plus optional migration tools). The `server.ts` aggregates definitions via `*ToolDefinitions()` functions and dispatches calls via `handle*Tool()` handlers. Each handler uses `src/tools/validation.ts` for input sanitization before delegating to the corresponding service. The full set is re-exported from `src/tools/index.ts`.

### MCP Tool Groups

**Knowledge tools** (10): `create_article`, `preview_slug`, `get_article`, `update_article`, `delete_article`, `list_articles`, `search_articles`, `batch_create_articles`, `batch_get_articles`, `batch_update_articles`
**Work tools** (11): `create_work`, `get_work`, `update_work`, `delete_work`, `list_work`, `advance_phase`, `contribute_enrichment`, `assign_reviewer`, `submit_review`, `add_dependency`, `remove_dependency`
**Search tools** (5): `search`, `build_context_pack`, `index_article`, `remove_from_index`, `reindex_all`
**Orchestration tools** (2): `log_event`, `get_events`
**Wave tools** (3): `plan_wave`, `execute_wave`, `evaluate_readiness`
**Agent tools** (3): `list_agents`, `get_agent`, `get_agent_experience`
**Status tools** (1): `status`
**Ingest tools** (1): `ingest_local_sources`
**Structure/graph tools** (2): `get_neighbors`, `get_graph_summary`
**Wiki tools** (2): `get_wiki_index`, `get_wiki_log`
**Snapshot tools** (3, from `src/tools/snapshot-tools.ts`): `record_environment_snapshot`, `get_latest_environment_snapshot`, `compare_environment_snapshots` — physical-sandbox companions to the semantic context produced by `build_context_pack`.

Total: **43 MCP tools** (+ migration tools when v2 source is present).

---

## Surface 2: CLI (direct process)

**Transport:** Direct process invocation (`node dist/cli.js <command>`)
**Entry point:** `src/cli/main.ts` -> `main(args)`
**Purpose:** Human operators, scripts, CI pipelines

The CLI parses argv, creates a container via `withContainer()`, calls the same services, and writes formatted output to stdout. It covers a subset of MCP functionality plus additional operational commands.

### CLI Commands

**Top-level:** `serve`, `dashboard`, `status`, `search <query>`, `reindex`, `migrate`, `doctor`, `--version`, `--help`
**Knowledge subcommands:** `knowledge create`, `knowledge get`, `knowledge list`, `knowledge update`, `knowledge delete`
**Work subcommands:** `work create`, `work get`, `work list`, `work update`, `work delete`, `work advance`, `work enrich`, `work review`
**Ingest subcommands:** `ingest local`
**Doctor flags:** `--fix-stale-code-refs`, `--seed-current-docs`, `--archive-legacy`, `--scope <knowledge|work|all>`

The `doctor` command is CLI-only (no MCP equivalent) and performs health checks, stale code-ref pruning, legacy corpus archiving, and current-docs seeding.

---

## Surface 3: Dashboard (HTTP + static UI)

**Transport:** HTTP server (`node:http`) + optional static file serving (SPA from `public/`)
**Entry point:** `monsthera dashboard` -> `startDashboard(container, port)`
**Purpose:** Web UI for monitoring, browsing, and managing articles

### REST API Endpoints

**Health/Status:**
- `GET /api/health` — subsystem health (exempt from auth)
- `GET /api/status` — full system status (exempt from auth)
- `GET /api/system/runtime` — deep runtime info (storage, search, orchestration config, capabilities, integrations, agent experience, recent events)

**Knowledge:**
- `GET /api/knowledge` — list all (with diagnostics enrichment)
- `POST /api/knowledge` — create
- `GET /api/knowledge/:id` — get (with diagnostics)
- `PATCH /api/knowledge/:id` — update
- `DELETE /api/knowledge/:id` — delete

**Work:**
- `GET /api/work` — list (filterable by phase)
- `POST /api/work` — create
- `GET /api/work/:id` — get (with diagnostics)
- `PATCH /api/work/:id` — update
- `DELETE /api/work/:id` — delete
- `POST /api/work/:id/advance` — phase advance
- `POST /api/work/:id/enrichment` — contribute enrichment
- `POST /api/work/:id/reviewers` — assign reviewer
- `POST /api/work/:id/review` — submit review
- `POST /api/work/:id/dependencies` — add dependency
- `DELETE /api/work/:id/dependencies` — remove dependency

**Search:**
- `GET /api/search?q=...` — search (enriched results)
- `GET /api/search/context-pack?q=...` — build context pack
- `POST /api/search/reindex` — full reindex

**Orchestration:**
- `GET /api/orchestration/wave` — plan next wave
- `POST /api/orchestration/wave/execute` — execute planned wave

**Structure:**
- `GET /api/structure/graph` — full knowledge graph

**Agents:**
- `GET /api/agents` — list registered agents
- `GET /api/agents/:id` — get agent detail

**Ingest:**
- `POST /api/ingest/local` — import local sources

### Auth Model

- Token-based Bearer authentication via `Authorization: Bearer <token>`
- Token auto-generated at startup (64-char hex from `crypto.randomBytes(32)`) or set via `MONSTHERA_DASHBOARD_TOKEN` env var
- **All GET and OPTIONS requests are exempt** from auth (read-only is open)
- `/api/health` and `/api/status` are always exempt regardless of method
- Token comparison uses `crypto.timingSafeEqual` to prevent timing attacks
- Static files served from `public/` directory with SPA fallback (extensionless paths serve `index.html`)

---

## Validation Layer

All MCP tool handlers share `src/tools/validation.ts`, which provides:

- `requireString(args, key, maxLength)` — required non-empty string with length cap
- `optionalString(args, key, maxLength)` — optional string with length cap
- `optionalNumber(args, key, min, max)` — optional bounded number
- `requireEnum(value, validValues, fieldName)` — enum membership check
- `isErrorResponse(value)` — type guard for validation errors
- `successResponse(data)` / `errorResponse(code, message)` — standardized MCP response builders

**Limits:** MAX_ID_LENGTH=64, MAX_TITLE_LENGTH=200, MAX_CONTENT_LENGTH=500000, MAX_QUERY_LENGTH=1000, MAX_TAG_LENGTH=100, MAX_TAGS_COUNT=50.

The Dashboard surface does its own HTTP-level validation inline (parsing JSON bodies, checking method+path, validating enums) and maps `MonstheraError` codes to HTTP status codes via `mapErrorToHttp()`.

---

## Shared Architecture

All three surfaces instantiate or receive the same `MonstheraContainer`, which provides:
- `knowledgeService` / `knowledgeRepo`
- `workService` / `workRepo`
- `searchService` / `searchRepo`
- `orchestrationRepo` / `orchestrationService`
- `ingestService`
- `structureService`
- `agentsService`
- `status` (StatusReporter)
- `migrationService` (optional, when v2 source is present)
- `config`, `logger`, `dispose()`

This ensures all surfaces share the same storage, index, and business logic. No surface has privileged access to services the others lack.

<!-- codex-related-articles:start -->
## Related Articles

- [[cli-entrypoint-and-command-routing]]
- [[package-entrypoints-and-barrel-exports]]
- [[wiki-surfaces-and-wikilink-semantics]]
- [[agent-and-wave-mcp-tools]]
<!-- codex-related-articles:end -->
