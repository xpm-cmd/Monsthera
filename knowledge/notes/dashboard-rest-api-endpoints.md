---
id: k-kmnflb56
title: Dashboard REST API endpoints
slug: dashboard-rest-api-endpoints
category: reference
tags: [dashboard, api, rest, endpoints, reference]
codeRefs: [src/dashboard/index.ts, src/dashboard/auth.ts, src/dashboard/agent-experience.ts, public/lib/api.js]
references: []
createdAt: 2026-04-11T02:20:25.323Z
updatedAt: 2026-06-10T23:22:23.321Z
---

# Dashboard REST API Endpoints

## Overview

Routing was split out of the old monolithic router (Wave D0): `src/dashboard/index.ts` (~190 lines) handles CORS, auth, a 405 method pre-guard, and dispatches an **ordered route chain**, while the route bodies live in `src/dashboard/routes/*.ts` domain modules — `system`, `orchestration`, `code-intel`, `ingest`, `agents`, `knowledge`, `work`, `search`, `sessions`, `convoys` — each exporting `handle<Domain>Routes(ctx): Promise<boolean>` over a shared `RouteContext` (`routes/context.ts`). The server is still raw Node.js `http.createServer()` with manual path/regex matching. Responses are JSON with `Content-Type: application/json`.

**CORS is a locked-down allowlist, not a wildcard**: `isAllowedDashboardOrigin()` (`src/dashboard/http.ts`) only accepts no-Origin callers and `http(s)` localhost/loopback origins. Other browser origins get `403 FORBIDDEN_ORIGIN`; allowed origins are echoed back via `Access-Control-Allow-Origin: <origin>` + `Vary: Origin`. `OPTIONS` preflight returns 204 with allowed methods/headers and a 24h max-age.

## Authentication

- **Every `/api/*` request — including GET — requires** `Authorization: Bearer <token>` (since PR #143; GETs expose the corpus, so the old GET exemption is gone).
- **Exempt paths** (any method): `/api/health`, `/api/status` — safe for monitoring.
- **Exempt method**: `OPTIONS` only (CORS preflight carries no Authorization header).
- Token is validated with `crypto.timingSafeEqual()` (length pre-checked); configured via `MONSTHERA_DASHBOARD_TOKEN` or auto-generated at startup.
- The server injects the token into served HTML as `<meta name="monsthera-auth-token">`; the SPA (`public/lib/api.js`) reads it and attaches it to every request.
- Invalid/missing token returns `401 { error: "UNAUTHORIZED", message: "Valid Bearer token required" }`.

## Method Pre-guard

Before the route chain, non-GET requests to the read-only paths `/api/health`, `/api/status`, `/api/search`, `/api/search/context-pack`, `/api/structure/graph`, `/api/agents`, `/api/system/runtime`, `/api/events`, and `/api/orchestration/wave` are rejected with `405 METHOD_NOT_ALLOWED`.

## Error Format

All errors follow: `{ error: "<CODE>", message: "<description>" }`

`mapErrorToHttp()` (in `http.ts`) maps domain error codes to HTTP status:
- `NOT_FOUND` → 404
- `VALIDATION_FAILED` → 400
- `ALREADY_EXISTS` → 409
- `STATE_TRANSITION_INVALID` → 409
- `GUARD_FAILED` → 422
- `PERMISSION_DENIED` → 403
- `CONCURRENCY_CONFLICT` → 409
- `STORAGE_ERROR` → 500
- anything else → 500

Plus router-level codes: `METHOD_NOT_ALLOWED` → 405, `UNAUTHORIZED` → 401, `FORBIDDEN_ORIGIN` → 403.

## Response Helpers (`src/dashboard/http.ts`)

- `jsonResponse(res, status, data)` — sends JSON
- `errorResponse(res, status, code, message)` — sends error JSON
- `parseJsonBody(req)` — reads request body up to 1MB, returns `{ ok, value }` or `{ ok: false, message }`
- `corsHeaders(res, origin)` — preflight response; `applyCorsHeaders(res, origin)` — echo allowed origin
- `serveStatic(...)` / `injectAuthToken(...)` — static files + token meta-tag injection

---

## Health & Status

### `GET /api/health`
System health check. Auth-exempt.

**Response** (200 or 503):
```json
{
  "healthy": true,
  "version": "3.x.x",
  "uptime": 12345,
  "subsystems": [
    { "name": "storage", "healthy": true, "detail": "..." },
    { "name": "search", "healthy": true, "detail": "..." }
  ]
}
```
Returns 503 if any subsystem is unhealthy.

### `GET /api/status`
Full system status. Auth-exempt.

**Response** (200): Complete `SystemStatus` object including version, uptime, subsystems, and `stats` (article counts, index size, timestamps).

---

## System Runtime & Eval

### `GET /api/system/runtime`
Comprehensive runtime configuration and state. Aggregates data from multiple services in parallel.

**Response** (200):
```json
{
  "storage": {
    "mode": "markdown+dolt" | "markdown-only",
    "markdownRoot": "/path/to/knowledge",
    "doltEnabled": true,
    "doltHost": "...", "doltPort": 3306, "doltDatabase": "...",
    "detail": "...", "healthy": true
  },
  "search": {
    "semanticEnabled": true,
    "embeddingProvider": "ollama",
    "embeddingModel": "nomic-embed-text",
    "alpha": 0.5,
    "ollamaUrl": "http://localhost:11434"
  },
  "orchestration": {
    "autoAdvance": true,
    "pollIntervalMs": 30000,
    "maxConcurrentAgents": 3,
    "running": true
  },
  "server": { "host": "127.0.0.1", "port": 3100 },
  "capabilities": {
    "knowledgeCrud": true, "workCrud": true, "phaseAdvance": true,
    "reviewWorkflow": true, "agentDirectory": true, "knowledgeIngest": true,
    "searchReindex": true, "searchAutoSync": true, "contextPacks": true,
    "wavePlanning": true, "waveExecution": true, "dashboardApi": true,
    "mcpServer": true, "migrationAvailable": false
  },
  "integrations": [ { "id": "markdown", "name": "...", "configured": true, "healthy": true, "detail": "..." }, ... ],
  "security": {
    "localFirst": true, "markdownSourceOfTruth": true,
    "reviewGateEnforced": true, "semanticSearchEnabled": true,
    "autoAdvanceEnabled": true,
    "externalEndpoints": ["localhost:11434"]
  },
  "stats": { ... },
  "agentExperience": { "scores": { ... }, "recommendations": [ ... ] },
  "recentEvents": [ ... ]
}
```

The `agentExperience` field is computed by `src/dashboard/agent-experience.ts` and includes overall/contract/coverage/flow scores plus actionable recommendations with severity, impact type, and links.

### `GET /api/system/eval`
Committed retrieval-eval baseline plus live semantic state. Reads `tests/eval/baseline.json` from the repo root.

**Response** (200): `{ "baseline": { engine, k, caseCount, aggregate: { ndcgAtK, mrr, recallAtK, contaminationRate }, ... }, "live": { "semanticEnabled": true, "embeddingModel": "..." } }`

Returns 404 `NOT_FOUND` in repos without a committed baseline (consumer repos) — the dashboard's Retrieval-quality card hides itself in that case. Non-GET → 405.

---

## Knowledge (CRUD + batch + slug tooling)

### `GET /api/knowledge`
List all knowledge articles. Optional query param `?category=<category>` to filter.

**Response** (200): Array of knowledge articles, each enriched with `diagnostics` and `recommendedFor` fields from `inspectKnowledgeArticle()`.

### `GET /api/knowledge/:id`
Get a single knowledge article by ID.

**Response** (200): Article object with diagnostics. 404 if not found.

### `POST /api/knowledge`
Create a new knowledge article.

**Request body**: `{ title, category, content, tags?, codeRefs?, references? }`

**Response** (201): Created article object.

### `PATCH /api/knowledge/:id`
Update an existing knowledge article.

**Request body**: Partial article fields to update (e.g., `{ content, tags }`). Also accepts `new_slug` (collision-checked atomic rename; incoming references in other articles update automatically) and `rewrite_inline_wikilinks`.

**Response** (200): Updated article object.

### `DELETE /api/knowledge/:id`
Delete a knowledge article.

**Response** (200): `{ ok: true, id: "<id>" }`

### `POST /api/knowledge/batch` / `PATCH /api/knowledge/batch`
Batch create (`{ articles: [...] }`) or batch update (`{ updates: [...] }`). Matched before the `:id` regex so "batch" is never read as an article ID. Each call accepts at most 100 entries (`MAX_BATCH_ARTICLES`); entries are applied independently — partial failures don't abort the batch.

**Response** (200): `{ total, succeeded, failed, items: [ { index, ok, article? , error? } ] }`

### `POST /api/knowledge/preview-slug`
Preview the slug a title would generate. Body: `{ title }` (non-empty string required).

**Response** (200): `{ slug, alreadyExists, conflicts }` — conflicts are near-miss slugs.

---

## Work (CRUD + Lifecycle)

### `GET /api/work`
List all work articles. Optional query param `?phase=<phase>` to filter. Valid phases: planning, enrichment, implementation, review, done, cancelled.

**Response** (200): Array of work articles enriched with `diagnostics` and `recommendedFor`.

### `GET /api/work/:id`
Get a single work article by ID.

**Response** (200): Work article with diagnostics.

### `POST /api/work`
Create a new work article.

**Request body**: `{ title, template, priority?, author?, assignee?, content?, codeRefs?, references? }`

**Response** (201): Created work article.

### `PATCH /api/work/:id`
Update an existing work article.

**Request body**: Partial fields to update.

**Response** (200): Updated work article.

### `DELETE /api/work/:id`
Delete a work article.

**Response** (200): `{ ok: true, id: "<id>" }`

### `POST /api/work/:id/advance`
Advance a work article to a new phase.

**Request body**: `{ phase, reason?, skipGuard? }`
- `phase`: must be in `VALID_PHASES` (including `cancelled`), else 400.
- `reason` (optional): non-empty string, max 1000 chars — recorded in phase history (used for cancellations).
- `skipGuard` (optional): `{ reason }` only — bypasses failing guards with an auditable justification (same constraints; unknown keys rejected).

**Response** (200): Updated work article. Guard failures without `skipGuard` surface as `422 GUARD_FAILED`.

### `POST /api/work/:id/enrichment`
Record an enrichment contribution for a role.

**Request body**: `{ role: "<role>", status: "contributed" | "skipped" }`

**Response** (200): Updated work article.

### `POST /api/work/:id/reviewers`
Assign a reviewer agent to a work article.

**Request body**: `{ reviewerAgentId: "<agent-id>" }`

**Response** (200): Updated work article.

### `POST /api/work/:id/review`
Submit a review verdict for a work article.

**Request body**: `{ reviewerAgentId: "<agent-id>", status: "approved" | "changes-requested" }`

**Response** (200): Updated work article.

### `POST /api/work/:id/dependencies`
Add a dependency (this work is blocked by another).

**Request body**: `{ blockedById: "<work-id>" }`

**Response** (200): Updated work article.

### `DELETE /api/work/:id/dependencies?blockedById=<id>`
Remove a dependency. The `blockedById` can be in query param or request body.

**Response** (200): Updated work article.

### `GET /api/work/:id/snapshot-diff?against=<snapshotId>`
Return the baseline-vs-current environment snapshot diff for a work article. Used by the dashboard to render the snapshot-drift band on expanded work cards.

**Query params**:
- `against` (optional): Specific baseline snapshot ID to diff against. If omitted, the service picks the oldest snapshot for the work that is not the current one.

**Response** (200):
```json
{
  "current": { "id": "...", "workId": "...", "capturedAt": "...", "cwd": "...", "branch": "...", "sha": "...", "dirty": false, "runtimes": { "node": "20.x" }, "packageManagers": [...], "lockfiles": [...] },
  "baseline": { ... } ,
  "diff": {
    "cwdChanged": false,
    "branchChanged": false,
    "shaChanged": true,
    "dirtyChanged": false,
    "packageManagersChanged": false,
    "runtimesChanged": ["node"],
    "lockfilesChanged": [],
    "ageDeltaSeconds": 1234
  }
}
```
When only a single snapshot exists for the work article, `baseline` and `diff` are both `null` (the caller still learns that a current snapshot exists but has nothing to compare against). Returns 404 `{ error: "NOT_FOUND", message: "No snapshot recorded for work id \"<id>\"" }` when no snapshots have been recorded at all. Served by `container.snapshotService.getDiffForWork()`.

---

## Search

### `GET /api/search?q=<query>&limit=<n>`
Hybrid BM25 + semantic search across knowledge and work articles.

**Response** (200): Array of enriched results:
```json
[
  {
    "id": "...", "title": "...", "type": "knowledge" | "work",
    "score": 0.85, "snippet": "...",
    "category": "...", "updatedAt": "...", "sourcePath": "...",
    "codeRefs": [...], "diagnostics": { ... }
  }
]
```
Knowledge results include `category`, `sourcePath`, `codeRefs`. Work results include `template`, `phase`, `references`.

### `GET /api/search/context-pack?q=<query>&mode=<mode>&limit=<n>&type=<type>`
Build a ranked context pack for agent consumption. Delegates to `container.searchService.buildContextPack()` — the same code path backing the `build_context_pack` MCP tool.

**Query params**:
- `q` (required): Search query. 400 `VALIDATION_FAILED` if missing.
- `mode` (optional): `"code"`, `"research"`, or `"general"`.
- `limit` (optional): Max results (default varies by mode). Parsed with `Number()`.
- `type` (optional): `"knowledge"`, `"work"`, or `"all"`.

**Response** (200): Context pack object with ranked items, quality scores, freshness/stale-ref diagnostics, and guidance.

### `POST /api/search/reindex`
Trigger a full reindex of the search index.

**Response** (200): `{ knowledgeCount: N, workCount: N }`

---

## Orchestration & Events

### `GET /api/orchestration/wave?autoAdvanceOnly=0|1`
Plan the next orchestration wave (read-only).

**Response** (200):
```json
{
  "generatedAt": "...",
  "autoAdvanceOnly": false,
  "autoAdvanceEnabled": true,
  "running": true,
  "ready": [
    { "workId": "...", "title": "...", "from": "planning", "to": "enrichment", "template": "...", "priority": "...", "assignee": "...", "updatedAt": "..." }
  ],
  "blocked": [
    { "workId": "...", "title": "...", "phase": "...", "reason": "..." }
  ],
  "summary": { "readyCount": 3, "blockedCount": 1 }
}
```

### `POST /api/orchestration/wave/execute?autoAdvanceOnly=0|1`
Execute the planned wave — advance all ready items.

**Response** (200):
```json
{
  "executedAt": "...",
  "autoAdvanceOnly": false,
  "autoAdvanceEnabled": true,
  "summary": { "plannedCount": 3, "blockedCount": 1, "advancedCount": 2, "failedCount": 1 },
  "advanced": [ { "workId": "...", "title": "...", "from": "planning", "to": "enrichment", "phase": "enrichment" } ],
  "failed": [ { "workId": "...", "title": "...", "error": "..." } ],
  "blocked": [ { "workId": "...", "title": "...", "reason": "..." } ]
}
```

### `GET /api/events?type=<type>&workId=<id>&limit=<n>`
Orchestration event stream (backs the `/events` page). `type` must be a valid orchestration event type (400 otherwise); `limit` defaults to 100, max 1000; `workId` filters to one article (sorted newest-first).

**Response** (200): `{ "events": [ { id, workId, agentId?, eventType, details, createdAt }, ... ] }`

### `POST /api/events/emit`
Agent-harness lifecycle emission (ADR-008). Accepts only `type` ∈ {`agent_started`, `agent_completed`, `agent_failed`}; requires `workId` (must exist — 404 otherwise), `role`, `from`, `to`; `agentId` optional; `error` required when `type=agent_failed`.

**Response** (201): the logged event.

---

## Structure & Code Intelligence

### `GET /api/structure/graph`
Returns the knowledge graph structure (nodes and edges) for visualization.

**Response** (200): Graph object with nodes (knowledge articles, work articles, code refs), edges (references, dependencies, code refs, shared tags), and a summary (counts + missing-ref/dependency/code gaps).

### `GET /api/code/ref?path=<path>`
ADR-015 code-ref intelligence: what the corpus knows about one path. `path` query param required (400 otherwise).

### `GET /api/code/owners?path=<path>`
Owners (work/knowledge articles) referencing the path.

### `GET /api/code/impact?path=<path>`
Full impact analysis for the path: existence, owners, active work, policies, risk, reasons, recommended actions. Backs the `/code` page's inspect panel.

### `POST /api/code/changes`
Mirrors the `code_detect_changes` MCP tool. Body: `{ changed_paths: string[] }` — must be a non-empty array of strings (400 otherwise; empty arrays rejected so a misconfigured client cannot silently no-op).

**Response** (200): per-path impacts for the changed set.

---

## Agents

### `GET /api/agents`
List all registered agent profiles with summary statistics.

**Response** (200): `{ agents: [...], summary: { currentPhaseCounts: {...} } }`

### `GET /api/agents/:id`
Get a single agent profile by ID.

**Response** (200): Agent profile object. 404 if not found.

---

## Sessions

Read-only (Wave D2) — opening/closing sessions stays with the CLI/MCP lifecycle (`session_open` / `session_close`).

### `GET /api/sessions`
List sessions, sorted by `openedAt` descending.

**Response** (200): `{ "sessions": [ { id, agentId, status, openedAt, closedAt?, branch?, repo?, intent?, handoffArticleId?, ... } ] }`

### `GET /api/sessions/:id`
Single session by ID (URI-decoded). Includes handoff article id, quality score, and abandon reason when present.

**Response** (200): session object. 404 if not found. Non-GET → 405.

---

## Convoys

Read-only projections (`src/dashboard/convoy-projection.ts`); creation/cancellation stays with the CLI/MCP.

### `GET /api/convoys`
Dashboard summary: `{ active: [...], terminal: [...], warnings: [...] }` — convoy cards include lead state, members with phases, goal, and unresolved lead-cancellation warnings (the sidebar badge counts `warnings`).

### `GET /api/convoys/:id`
Convoy detail: header (goal, lead, target phase, status), guard state (passing/blocked), warning, member list, recent lead activity, and lifecycle events. 404 if not found.

---

## Ingest

### `POST /api/ingest/local`
Import local `.md`/`.txt` files into knowledge articles.

**Request body**: Ingest configuration (paths, options).

**Response** (200): Import result with created article details.

---

## Frontend API Client (`public/lib/api.js`)

The frontend wraps all endpoints in a typed API client:
- `request(path, options)` — core fetch wrapper. Auto-serializes JSON bodies, throws `ApiError` on non-OK responses.
- Reads the injected `<meta name="monsthera-auth-token">` and attaches `Authorization: Bearer <token>` to **every** request (GETs included — they're auth-gated too).
- `ApiError` extends `Error` with `status` and `code` properties.
- Each endpoint has a named export: `getHealth()`, `getKnowledge(category?)`, `createWork(input)`, `advanceWork(id, phase, options)`, `getSessions()`, `getSessionById(id)`, `getConvoys()`, `getConvoyById(id)`, `getSystemEval()`, `getEvents({type, workId, limit})`, `emitEvent(payload)`, `getCodeRef/Owners/Impact(path)`, `detectCodeChanges(paths)`, `previewSlug(title)`, `renameKnowledgeSlug(...)`, `batchCreateKnowledge(...)`, `batchUpdateKnowledge(...)`, etc.
- Query params are built with `URLSearchParams` and encoded with `encodeURIComponent`.
- 204 responses return `null`.