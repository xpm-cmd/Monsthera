# Changelog

All notable changes to Monsthera are documented here.

## [Unreleased]

## [3.0.0-alpha.3] — 2026-04-18

**Tier 2.4 — Dashboard ↔ MCP parity.** Three focused PRs that close
the UI drift accumulated during Tier 1/2: every feature that shipped
as an MCP tool now has a dashboard surface, and every feature exposed
in the dashboard now has a corresponding MCP tool. The service layer
did not change.

### Added

- **`POST /api/work/:id/advance` accepts `reason` and `skipGuard: { reason }`** (#47 — Tier 2.4 A.1). Mirrors the `advance_phase` MCP contract from Tier 2.1. The dashboard now shows "Override guards" (always visible) and "Cancel" actions next to "Move to X" on every work card; both collect a justification via prompt and record it in phase history. When a normal advance hits `GUARD_FAILED`, the UI offers an inline override retry. `mapErrorToHttp` now maps `GUARD_FAILED` → 422, `STATE_TRANSITION_INVALID` / `ALREADY_EXISTS` / `CONCURRENCY_CONFLICT` → 409, and `PERMISSION_DENIED` → 403, so the UI can distinguish recoverable policy failures from 500s.
- **`POST /api/knowledge/preview-slug`** (#48 — Tier 2.4 A.2). Exposes the `preview_slug` tool shipped in Tier 1.3. The dashboard create form now shows a debounced (300 ms) slug preview under the title input with warnings for existing slugs and near-miss conflicts. The editor gains a "Rename slug" form with a confirm prompt and an opt-in checkbox to rewrite inline `[[old-slug]]` wikilinks in other articles' bodies — mirroring the atomic rename semantics from Tier 2.2.
- **`POST /api/knowledge/batch` + `PATCH /api/knowledge/batch`** (#49 — Tier 2.4 A.3). Exposes `batch_create_articles` / `batch_update_articles` shipped in Tier 2.3. New "Bulk import (JSON)" card in the knowledge page: mode toggle (Create / Update), textarea, client-side "Validate" button that runs JSON parse + shape check before hitting the backend, per-item results panel so callers can retry only the offenders.
- **`plan_wave`, `execute_wave`, `evaluate_readiness` MCP tools** (#50 — Tier 3.1 B.1). The dashboard has had wave planning / execution endpoints since the first v3 promotion; MCP only exposed `log_event` / `get_events`. Autonomous agents can now triage ready work and advance waves without going through the HTTP surface. `plan_wave` items are enriched with title, template, priority, assignee so agents do not need an extra `get_work` per row. `evaluate_readiness` is a dry-run for a single article that returns per-guard pass/fail — use before `advance_phase` to decide whether `skip_guard` is legitimate.
- **`list_agents`, `get_agent`, `get_agent_experience` MCP tools** (#51 — Tier 3.2 B.2). The derived agent directory and the operator-cockpit snapshot (contract / context / ownership / review scores, coverage metrics, automation posture, ranked recommendations) were dashboard-only. Autonomous agents can now self-assess and discover owners without hitting HTTP. `get_agent_experience` reuses the same `deriveAgentExperience` scoring function the dashboard uses — no duplicated logic.

### Changed

- **`create_work` MCP tool now documents `assignee`, `references`, and `codeRefs`** (#51 — Tier 3.2 B.2). The underlying Zod schema has accepted all three since v3 shipped; only the tool's JSON schema hid them from the LLM, forcing a `create + update` dance whenever owner or refs were known upfront. Behavior is unchanged for callers that already included the fields.
- **`.gitignore` extended** for personal AI tool configs (`.copilot/`, `.cursorrules`, `.cursorignore`, `*.local.md`, `settings.local.json`). The v2-era phase execution prompts (`phase-6-prompt.md`..`phase-9-prompt.md`) have been moved from the repo root to `docs/history/` to stop crowding the top level — they remain available for reference but are no longer part of the active working set.

### Fixed

- **Dashboard SPA auth wiring** (#52). The dashboard HTTP layer has required a Bearer token on every mutating request since v3 shipped, but the SPA never attached one — every UI-driven mutation silently 401'd. `serveStatic` now injects `<meta name="monsthera-auth-token" content="...">` into every HTML response, and `public/lib/api.js::request` reads it and attaches `Authorization: Bearer <token>` automatically. Same-origin trust boundary; no wider exposure.

## [3.0.0-alpha.2] — 2026-04-18

**Tier 2 — Orchestration and bulk ergonomics.** Three features that close the Tier 2 section of the v3 roadmap: template-specific phase flows with auditable escape hatches (2.1), atomic slug rename with cross-article reference updates (2.2), and bulk article operations for imports and backfills (2.3).

### Added

- **`batch_create_articles` MCP tool**: create 1–100 knowledge articles in a single call. Same per-item schema as `create_article`. Best-effort: each entry is validated and applied independently; per-item `{ ok, article | error: { code, message } }` surfaced in the response so callers can retry offenders without replaying successes. `index.md` rebuild deferred to once per batch. [Tier 2.3]
- **`batch_update_articles` MCP tool**: update 1–100 knowledge articles in a single call. Each entry requires `id` plus any subset of `update_article` fields (including `new_slug` / `rewrite_inline_wikilinks`). Rename semantics match `update_article` — per-item collision check and referrer updates still apply. [Tier 2.3]
- **Atomic slug rename via `update_article({ new_slug })`**: renames the article and updates every other article's `references` array in a single operation. Collision-checked, audit-logged. Opt in to inline wikilink rewriting across other articles' bodies via `rewrite_inline_wikilinks: true` (default false because bodies are content). Transactional-ish: staged writes with pre-image rollback on failure. [Tier 2.2]
- **Per-template phase flows**: `spike` template now advances `planning → enrichment → done` (skips implementation + review). Feature/bugfix/refactor flows unchanged. [Tier 2.1]
- **Mandatory cancellation reason**: `advance_phase` now requires a `reason` parameter when transitioning to `cancelled`. Recorded in phase history for audit. [Tier 2.1]
- **`skip_guard` escape hatch**: `advance_phase` accepts optional `skip_guard: { reason }` to bypass a failing guard with an auditable justification. Skipped guards and reason are recorded in the new phase-history entry. Structural transition validity is NOT bypassed. [Tier 2.1]

### Changed

- **`KnowledgeService`** exposes `createOneWithoutRebuild` / `updateOneWithoutRebuild` internally; the public `createArticle` / `updateArticle` are now thin wrappers that trigger the wiki `index.md` rebuild. Behavior for single-article callers is unchanged. [Tier 2.3]
- **`update_article` schema** gained `new_slug` and `rewrite_inline_wikilinks` optional fields. Existing update calls without these fields behave identically. [Tier 2.2]
- **`PhaseHistoryEntry`** gained optional `reason` and `skippedGuards: string[]` fields. Existing persisted history without these fields reads back unchanged. [Tier 2.1]

## [3.0.0-alpha.1] — 2026-04-18

**Tier 1 — Credibility of the gap report.** Three focused fixes that turn `get_graph_summary` from "mostly noise" into "mostly signal" for the Aloea wiki use case, validated live: `missingReferenceCount` dropped from 135 → 74 (−45%), all remaining entries are legitimate gaps.

### Added

- **`preview_slug` tool**: returns the slug that would be generated for a given title, whether it already exists, and any near-miss conflicts (Jaccard similarity ≥ 0.7 on hyphen-split tokens). Read-only; call before `create_article` for nontrivial titles to avoid silent cross-link drift. [Tier 1.3]
- **`create_article` optional `slug` param**: accept an explicit slug to override auto-generation. Format validated (`^[a-z0-9-]+$`) via Zod; collisions return `ALREADY_EXISTS` errors recommending `preview_slug` first, instead of silent behavior. [Tier 1.3]

### Fixed

- **Wikilink parser — Obsidian pipe-syntax and anchors**: strip display text (`[[slug|display]]`) and anchor suffixes (`[[slug#section]]`) when extracting slugs for reference resolution. Extraction now lives in `src/structure/wikilink.ts` as pure helpers (`parseWikilink`, `extractWikilinks`) returning `{ slug, display, anchor }`. Eliminates 54 false-positive missing references against the Aloea wiki (135 → 81 live). [Tier 1.1]
- **Wikilink parser — code regions**: new `stripCodeRegions` helper skips content inside fenced code blocks (```` ``` ```` / `~~~`), inline backtick spans (1–3 backticks), and HTML comments (`<!-- ... -->`) before wikilink extraction. Processing order: HTML comments → fenced blocks → inline code, to avoid triple-backtick inline being mistaken for a fence opener. Zero new dependencies. Eliminates the last 7 false-positive missing references from template placeholders and example snippets (81 → 74 live). [Tier 1.2]

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
