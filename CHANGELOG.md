# Changelog

All notable changes to Monsthera are documented here.

## [Unreleased]

### Added

- **`preview_slug` tool**: returns the slug that would be generated for a given title, whether it already exists, and any near-miss conflicts (Jaccard similarity ≥ 0.7 on hyphen tokens). Call before `create_article` for nontrivial titles to avoid silent cross-link drift. [Tier 1.3]
- **`create_article` optional `slug` param**: accept an explicit slug to override auto-generation. Collisions and invalid format return clear errors instead of silent behavior. [Tier 1.3]

### Fixed

- **Wikilink parser**: strip display text (`[[slug|display]]`) and anchor suffixes (`[[slug#section]]`) when extracting slugs for reference resolution. Eliminates 56 false-positive missing references against typical Obsidian-style wikis. [Tier 1.1]
- **Wikilink parser**: skip content inside fenced code blocks (```` ``` ```` / `~~~`), inline code (`` ` ``..`` ` ``), and HTML comments (`<!-- ... -->`) when extracting wikilinks. Eliminates the last 4 false-positive missing references from template placeholders and example snippets in protocol/log articles. [Tier 1.2]

### Changed

- **Rebrand: Agora → Monsthera** — Renamed all references in root-level markdown files (README, AGENT-MEMORY-CONTEXT, AGENTS, CONTRIBUTING, SECURITY, CHANGELOG). Updated product name, CLI commands, npm package (`monsthera-mcp`), directory paths (`.monsthera/`), database name (`monsthera.db`), HTTP headers (`x-monsthera-`), and GitHub URLs (`xpm-cmd/Monsthera`).

## [2.0.1] - 2026-03-23

### Fixed

- **spawn_agent auth token** — `spawn_agent` now correctly passes `authToken` from `registrationAuth.roleTokens` to `registerAgent()`, fixing agent registration failures when auth is enabled
- **Orchestrator response parsing** — `asRecord()` now unwraps MCP-style `{ content: [{ text: "{...}" }] }` responses so `agentId`/`sessionId` are correctly extracted instead of silently falling back to `"orchestrator"`
- **Fail-fast on missing agent identity** — Replaced silent fallbacks with explicit errors when `agentId`/`sessionId` are missing from spawn responses

### Added

- **Symbol references + code chunks** — Tree-sitter extracts function calls, member calls, and type references into `symbol_references`. Code chunks store per-symbol line ranges with embeddings for finer semantic search (`c00d628`)
- **Chunk-level semantic embeddings** — `monsthera index --semantic` generates 384-dim MiniLM embeddings per function/class chunk, enabling sub-file precision in vector search (`23134f1`)
- **Work groups + convoy pattern** — Aggregate multi-ticket features in work groups with auto-completion. Convoy model groups independent tickets into waves for parallel execution (`6d1866c`)
- **Goal decomposition** — `decompose_goal` tool breaks high-level goals into DAG-validated task graphs with dependency tracking and dry-run mode (`e45253a`)
- **Coupling analysis + dependency cycles** — `analyze_coupling` scores file interconnectedness; `find_dependency_cycles` detects circular imports (`6be977e`)
- **Activity timeline** — Dashboard enriched with agent/ticket context in the activity feed (`0bf3090`)
- **Wave scheduler + convoy model** — Parallel ticket execution through computed waves with integration branches and coordinated merges (`13089f6`)
- **Agent spawning + lane-aware bus** — `spawn_agent` tool, coordination bus with message lanes, failover chains for agent reliability (`57d7fe8`)
- **Orchestrator hardening** — Phase 3 improvements: observability, cleanup, dashboard convoy views, simulation Phase E (`4a5d68c`)
- **Governance enforcement + council review** — Quorum-based ticket advancement with specialized council roles, append-only verdicts with supersession, and audit trail (`b0aa5e1`)
- **Job board** — Loop-based workforce management with typed job slots, claim/release lifecycle, and heartbeat monitoring
- **Simulation framework** — Multi-phase (A→E) simulation runs for testing ticket workflows, council review, and wave orchestration
- **Retention policy** — `pruneOldEvents()` utility for automatic cleanup of append-only event tables
- **72 MCP tools** — Tool surface expanded from 23 to 72 across 17 domains

### Changed

- **Session heartbeat timeout** — `HEARTBEAT_TIMEOUT_MS` now defaults to 3 hours so long-running implementation sessions keep the same agent identity across review and commit workflows (`c4bbcef`)
- **Architecture layer cleanup** — Moved `dashboard/events.ts` → `core/events.ts`, `tools/tool-manifest.ts` → `core/tool-manifest.ts`, extracted `ToolRunnerCallResult` to `core/tool-types.ts`, and `autoCompleteWorkGroups` to `work-groups/completion.ts` to fix upward dependency violations
- **Batch query optimization** — Eliminated N+1 queries in evidence bundle, semantic reranker, and knowledge search with batch `getFilesByPaths()`/`getKnowledgeByIds()`
- **Dashboard resilience** — SSE debounce (2s), exponential backoff reconnection (1s→30s), `Promise.allSettled` for partial failure handling, refresh re-entrancy guard, `document.hidden` visibility check
- **Vector search optimization** — Removed `content` column from initial knowledge vector scan to reduce memory pressure
- **Batch inserts** — Indexer now uses single batch `INSERT` for imports and symbol references instead of per-row inserts

### Fixed

- **Command injection** — Shell metacharacter validation in `runTestsInWorktree` before `sh -c` execution
- **XSS** — Added single-quote (`&#39;`) escaping to dashboard `esc()` function
- **Path traversal** — Vault path validation in Obsidian export endpoint (must be within repo or home directory)
- **TOCTOU races** — Converted 4 upsert functions (`upsertRepo`, `upsertAgent`, `upsertKnowledge`, `upsertCouncilAssignment`) to atomic `onConflictDoUpdate`
- **Transaction safety** — `fullIndex()` wrapped in `BEGIN IMMEDIATE` transaction; Migration 11 `DROP`+`RENAME` wrapped in transaction
- **LIKE injection** — Escaped `%` and `_` wildcards in `searchFilesByPath` and `getFilesImporting`
- **YAML injection** — Obsidian export uses `JSON.stringify()` for safe YAML value serialization
- **Zod import** — Fixed `simulation-tools.ts` to use `zod/v4` instead of `zod`
- **Toast timer race** — Dashboard toast now clears previous timer before setting new one
- **13 missing indexes** — Added indexes for high-traffic query patterns including `files(repo_id, path)`, `tickets(repo_id, status)`, `event_logs(timestamp)`, and more
- **Global DB pragmas** — Added `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL` to global database initialization

## [1.0.0] — 2026-03-09

### QA Evolution (v1 → v12)

The v1.0.0 release went through 12 QA iterations improving search quality, agent coordination, and knowledge retrieval from a D+ to an A grade.

### Added

- **Semantic embeddings + CamelCase tokenization** — ONNX MiniLM-L6-v2 wired to `monsthera index`, CamelCase identifiers tokenized for FTS5 matching (`04313d7`)
- **Independent vector search for knowledge** — `search_knowledge` runs a full vector scan over all embeddings (cosine ≥ 0.6) in parallel with FTS5, discovering entries with zero keyword overlap (`a132110`)
- **Session lifecycle cleanup** — `end_session` tool for explicit session disconnect, `reapStaleSessions()` for automatic stale session expiry after `HEARTBEAT_TIMEOUT_MS` (initially 10 min in v1.0.0), claim release on disconnect (`3d789c4`)
- **Agent timestamps + diff stats** — `agent_status` includes session timestamps; `get_change_pack` includes per-commit diff stats (`1a4b491`)
- **Per-file diffs** — `get_change_pack` returns per-file unified diffs truncated to MAX_DIFF_LINES_PER_FILE = 50 lines (`2500a99`)
- **Observational `agent_status`** — no longer disconnects sessions as side effect; reaps stale sessions explicitly before building response (`a02dce6`, `3d789c4`)
- **Session count + visibility** — all sessions (active + disconnected) shown with timestamps and stale annotations (`9719cfb`)

### Changed

- **Evidence Bundle limits** — STAGE_A_MAX_CANDIDATES increased from 5 to 10, STAGE_B_MAX_EXPANDED from 3 to 5 (`f3d30d7`)
- **Dynamic search threshold** — scoped queries use MIN_RELEVANCE_SCORE_SCOPED = 0.15, unscoped use MIN_RELEVANCE_SCORE = 0.35 (`9719cfb`)
- **Query sanitization** — short queries (1-3 terms) use AND semantics, long queries (4+ terms) use OR with BM25 ranking (`0a4c3c1`)
- **Tool count** — 22 → 23 tools (added `end_session`)

### Fixed

- **Nonsense guard** — MIN_RELEVANCE_SCORE = 0.35 filters low-confidence results from evidence bundles (`eee95b8`)
- **WebSocket knowledge regression** — FTS5 AND semantics returned only 1 of 5 relevant knowledge entries; hybrid vector search recovered full recall (`a132110`)
- **Stale session accumulation** — swarm agents registered sessions but never disconnected; lifecycle cleanup reaps sessions inactive > 10 min in v1.0.0 (`3d789c4`)

### Constants Reference

| Constant | Value |
|----------|-------|
| STAGE_A_MAX_CANDIDATES | 10 |
| STAGE_B_MAX_EXPANDED | 5 |
| MAX_CODE_SPAN_LINES | 200 |
| MIN_RELEVANCE_SCORE | 0.35 |
| MIN_RELEVANCE_SCORE_SCOPED | 0.15 |
| MAX_DIFF_LINES_PER_FILE | 50 |
| HEARTBEAT_TIMEOUT_MS | 600,000 (10 min in v1.0.0) |
| CLAIM_RELEASE_TIMEOUT_MS | 300,000 (5 min) |

## [1.0.0-rc] — 2026-03-08

Initial release with 22 tools, FTS5 search, dashboard, knowledge store, Obsidian export.
