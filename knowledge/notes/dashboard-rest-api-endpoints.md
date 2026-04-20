---
id: k-kmnflb56
title: Dashboard REST API endpoints
slug: dashboard-rest-api-endpoints
category: reference
tags: [dashboard, api, rest, endpoints, reference]
codeRefs: [src/dashboard/index.ts, src/dashboard/auth.ts, src/dashboard/agent-experience.ts, public/lib/api.js]
references: []
createdAt: 2026-04-11T02:20:25.323Z
updatedAt: 2026-04-20T00:00:00.000Z
---

# Dashboard REST API Endpoints

## Overview

All API routes are handled by `src/dashboard/index.ts` in a single `handleRequest()` function. The server uses raw Node.js `http.createServer()` with manual route matching via regex. Responses are JSON with `Content-Type: application/json` and `Access-Control-Allow-Origin: *`.

## Authentication

- **All GET and OPTIONS requests are unauthenticated** (exempt by method).
- **POST, PATCH, DELETE requests require** `Authorization: Bearer <token>` header.
- Exempt paths (any method): `/api/health`, `/api/status`.
- Token is validated with `crypto.timingSafeEqual()`.
- Invalid/missing token returns `401 { error: "UNAUTHORIZED", message: "Valid Bearer token required" }`.

## Error Format

All errors follow: `{ error: "<CODE>", message: "<description>" }`

Error codes map to HTTP status:
- `NOT_FOUND` → 404
- `VALIDATION_FAILED` → 400
- `STORAGE_ERROR` → 500
- `METHOD_NOT_ALLOWED` → 405

## Response Helpers

- `jsonResponse(res, status, data)` — sends JSON with CORS headers
- `errorResponse(res, status, code, message)` — sends error JSON
- `parseJsonBody(req)` — reads request body up to 1MB, returns `{ ok, value }` or `{ ok: false, message }`

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

## System Runtime

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

---

## Knowledge (CRUD)

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

**Request body**: Partial article fields to update (e.g., `{ content, tags }`).

**Response** (200): Updated article object.

### `DELETE /api/knowledge/:id`
Delete a knowledge article.

**Response** (200): `{ ok: true, id: "<id>" }`

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

**Request body**: `{ phase: "enrichment" | "implementation" | "review" | "done" | ... }`

**Response** (200): Updated work article. Returns 400 if phase is invalid.

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

## Orchestration

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

---

## Structure

### `GET /api/structure/graph`
Returns the knowledge graph structure (nodes and edges) for visualization.

**Response** (200): Graph object with nodes (knowledge articles, work articles, code refs) and edges (references, shared tags, code ref links).

---

## Agents

### `GET /api/agents`
List all registered agent profiles with summary statistics.

**Response** (200): `{ agents: [...], summary: { currentPhaseCounts: {...} } }`

### `GET /api/agents/:id`
Get a single agent profile by ID.

**Response** (200): Agent profile object. 404 if not found.

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
- `ApiError` extends `Error` with `status` and `code` properties.
- Each endpoint has a named export: `getHealth()`, `getKnowledge(category?)`, `createWork(input)`, `advanceWork(id, phase)`, etc.
- Query params are built with `URLSearchParams` and encoded with `encodeURIComponent`.
- 204 responses return `null`.
