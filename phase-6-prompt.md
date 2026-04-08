# Phase 6: Surfaces — Session Prompt

## Project context

Monsthera v3 is a clean rewrite of a knowledge-native development platform for AI coding agents. It replaces the v2 ticket/council/SQLite model with article-based knowledge, work articles with lifecycle guards, and Dolt-backed persistence.

## Phase status

| Phase | Name | Status | Commit |
|-------|------|--------|--------|
| 0 | Bootstrap | Complete | `8a13a57` |
| 1 | Foundation | Complete | `d395a9a`, `b930c6c`, `6680af1` |
| 2 | Knowledge system | Complete | `1e9fc52` |
| 3 | Work article system | Complete | `6953c33`, `398208b` |
| 4 | Search and retrieval | Complete | `ffcd2bb` |
| 5 | Persistence | Complete | `a8e3430` |
| 6 | Surfaces | **This phase** |
| 7 | Orchestration | Pending |
| 8 | Migration | Pending |
| 9 | Hardening | Pending |

**Branch:** `rewrite/v3`
**Test count:** 596 tests, 30 test files, all passing
**Typecheck:** Clean (`pnpm typecheck` passes with zero errors)

## Canonical documents (read these first)

All in `MonstheraV3/` directory (untracked, present on disk):

1. **`monsthera-architecture-v6-final.md`** — Full architecture. Section 11 defines surface boundaries.
2. **`monsthera-ticket-as-article-design.md`** — Work article design rationale.
3. **`monsthera-v3-implementation-plan-final.md`** — Implementation plan. Section 4, Phase 6 deliverables.

## What Phase 6 must deliver

### 6.1 MCP tools (thin adapters over services)

The MCP tool stubs already exist in `src/tools/` with type definitions (`ToolDefinition`, `ToolResponse`). They need to be completed and registered with the MCP server.

**Knowledge tools** (`src/tools/knowledge-tools.ts`):
- `monsthera_create_knowledge` — create a knowledge article
- `monsthera_get_knowledge` — get by ID or slug
- `monsthera_list_knowledge` — list/filter articles by category, tag
- `monsthera_update_knowledge` — update an article
- `monsthera_delete_knowledge` — delete an article

**Work tools** (`src/tools/work-tools.ts`):
- `monsthera_create_work` — create a work article from template
- `monsthera_get_work` — get by ID
- `monsthera_list_work` — list/filter by phase, assignee, priority
- `monsthera_update_work` — update a work article
- `monsthera_advance_phase` — advance work article to next phase
- `monsthera_contribute_enrichment` — contribute to enrichment role
- `monsthera_assign_reviewer` — assign a reviewer
- `monsthera_submit_review` — submit a review
- `monsthera_add_dependency` — add a blocker
- `monsthera_remove_dependency` — remove a blocker

**Search tools** (`src/tools/search-tools.ts`):
- `monsthera_search` — full-text search across knowledge and work
- `monsthera_reindex` — rebuild search index

**Orchestration tools** (new file `src/tools/orchestration-tools.ts`):
- `monsthera_log_event` — log an orchestration event
- `monsthera_get_events` — get events by work ID or type

**Status tools** (new file `src/tools/status-tools.ts`):
- `monsthera_status` — get system status and health

### 6.2 MCP server registration

The MCP server exists at `src/server.ts`. It needs to:
- Import all tool definitions
- Register each tool with the MCP SDK (`server.setRequestHandler(ListToolsRequestSchema, ...)`)
- Wire tool handlers to call the appropriate service methods via the container
- Return proper JSON results using the `ToolResponse` type

### 6.3 CLI commands

The CLI entry point is `src/cli/main.ts` with `serve` and `status` commands. Extend with:
- `monsthera knowledge create|get|list|update|delete`
- `monsthera work create|get|list|update|advance|enrich|review`
- `monsthera search <query>`
- `monsthera reindex`
- All commands should format output for human readability (tables, colored status)

### 6.4 Dashboard (minimal)

`src/dashboard/index.ts` is currently empty. For Phase 6, implement a minimal JSON API:
- `GET /api/status` — system status
- `GET /api/knowledge` — list knowledge articles
- `GET /api/knowledge/:id` — get single article
- `GET /api/work` — list work articles with filter params
- `GET /api/work/:id` — get single work article
- `GET /api/search?q=<query>` — search

This can use the built-in Node.js HTTP server or a minimal framework. The dashboard is a **thin transport layer** — no business logic.

## Key files to read

| File | Purpose |
|------|---------|
| `src/core/container.ts` | Dependency container — all repos and services |
| `src/core/config.ts` | Configuration schema with all settings |
| `src/knowledge/service.ts` | Knowledge domain service |
| `src/work/service.ts` | Work domain service |
| `src/search/service.ts` | Search domain service |
| `src/tools/*.ts` | Existing tool stubs |
| `src/server.ts` | MCP server bootstrap |
| `src/cli/main.ts` | CLI entry point |
| `src/orchestration/repository.ts` | Orchestration event types |

## Architecture rules (Section 11)

1. **MCP tools are thin adapters**: validate input → call service → return JSON
2. **CLI commands are thin adapters**: parse args → validate → call service → format output
3. **Dashboard is a client of domain services**: no separate business logic
4. **No domain rules live only in a tool handler, CLI command, or dashboard route**

## Existing patterns to follow

- All service methods return `Result<T, E>` — surfaces must unwrap and format appropriately
- MCP tools return `ToolResponse` with `content: [{ type: "text", text: JSON.stringify(...) }]`
- Error results should map to `isError: true` responses
- The container provides all dependencies — tools/CLI/dashboard receive the container

## Workflow

1. Claude (Opus) plans each sub-deliverable
2. Claude implements using agents for parallel work
3. Submit to Codex for review (`node codex-companion.mjs review`)
4. Fix all findings
5. Run `pnpm test && pnpm typecheck` before committing
6. Commit with descriptive message

## Test expectations

- Each MCP tool should have unit tests verifying input validation, service delegation, and JSON response format
- CLI commands should have basic integration tests
- Dashboard routes should have request/response tests
- Target: maintain the pattern of ~20 tests per domain area
