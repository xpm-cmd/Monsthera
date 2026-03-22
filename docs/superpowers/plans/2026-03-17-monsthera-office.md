# Monsthera Office — Implementation Plan

> **For agentic workers:** This plan is designed to be consumed by an Monsthera agent. Use it to populate the knowledge store, generate a roadmap via `decompose_goal`, create tickets, compute waves, and launch a convoy. Each task maps to one or more Monsthera tickets.

**Goal:** Build a full-stack web app that visualizes Monsthera multi-agent activity as an isometric pixel art office in real time.

**Architecture:** Monorepo (pnpm workspaces) with 3 packages: `shared` (types), `server` (Node+Express reading Monsthera SQLite), `client` (React+PixiJS rendering isometric world). Server polls Monsthera DB and emits SSE events; client renders characters in rooms based on events.

**Tech Stack:** TypeScript, React 18, PixiJS 8, Zustand, Vite, Express, better-sqlite3, Tailwind CSS, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-03-17-monsthera-office-design.md`

---

## Development Setup & Runtime

### Prerequisites

```bash
node --version    # >= 20.x (LTS recommended)
pnpm --version    # >= 9.x
```

An **Monsthera instance with an existing database** is required. The server reads the `.monsthera/monsthera.db` file from the project being observed. You need the absolute path to this file.

### Environment Variables

Create a `.env` file in `packages/server/` (or export in your shell):

```bash
# Required — absolute path to the Monsthera SQLite DB you want to visualize
MONSTHERA_DB_PATH=/Users/you/Projects/your-project/.monsthera/monsthera.db

# Optional — all have sensible defaults
PORT=3001                          # Express server port
POLL_INTERVAL_MS=1500              # How often to poll Monsthera DB (ms)
CORS_ORIGIN=http://localhost:5173  # Vite dev server origin
MONSTHERA_REPO_ID=                     # Auto-detected from repos table if omitted
```

### Install & Build

```bash
# From repo root
pnpm install          # Install all 3 packages + their deps
pnpm build            # Build shared → server → client (in order)
tsc --build           # Typecheck all packages (no emit)
```

### Running in Development (Hot Reload)

You need **2 terminals** running simultaneously:

```bash
# Terminal 1 — Backend (Express + SSE + DB Poller)
MONSTHERA_DB_PATH=/path/to/.monsthera/monsthera.db pnpm --filter @monsthera-office/server dev

# Output:
#   Monsthera Office server listening on http://localhost:3001
#   Connected to Monsthera DB: /path/to/.monsthera/monsthera.db (repo: 1)
#   Poll loop started (interval: 1500ms)
#   SSE endpoint: http://localhost:3001/events
```

```bash
# Terminal 2 — Frontend (Vite + React + PixiJS)
pnpm --filter @monsthera-office/client dev

# Output:
#   VITE v5.x.x  ready in 500ms
#   ➜  Local:   http://localhost:5173/
```

Both services support hot reload:
- **Server:** Uses `tsx watch` — restarts on any `.ts` file change in `packages/server/src/`
- **Client:** Uses Vite HMR — React and CSS changes apply instantly without page reload. PixiJS engine changes require a manual refresh.

### Running in Production

```bash
# Build all packages
pnpm build

# Start server (reads from compiled JS)
MONSTHERA_DB_PATH=/path/to/.monsthera/monsthera.db node packages/server/dist/index.js

# Serve client static files (or use Vite preview)
pnpm --filter @monsthera-office/client preview  # Serves on http://localhost:4173
```

For production deployment, the server serves the client's static build output. The server `index.ts` includes a static file middleware that serves `packages/client/dist/` at the root path, so a single process handles both the API and the frontend.

### Service Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User's Browser                       │
│                                                         │
│    http://localhost:5173  (Vite dev)                     │
│    http://localhost:4173  (Vite preview/prod)            │
│                                                         │
│    Fetches:                                             │
│    ├─ GET http://localhost:3001/state   (initial load)   │
│    ├─ GET http://localhost:3001/events  (SSE stream)     │
│    ├─ GET http://localhost:3001/rooms   (room metadata)  │
│    └─ GET http://localhost:3001/health  (healthcheck)    │
└──────────────────────────┬──────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────┐
│  Express Server (http://localhost:3001)                   │
│                                                          │
│  Endpoints:                                              │
│  ├─ GET /health   → { status, uptime, clientCount }      │
│  ├─ GET /rooms    → Room[] (6 static rooms)              │
│  ├─ GET /state    → InitialState (full hydration)        │
│  └─ GET /events   → SSE stream (text/event-stream)       │
│                                                          │
│  Internal:                                               │
│  ├─ SSEManager    → tracks connected clients, broadcast  │
│  ├─ PollLoop      → setInterval(1500ms) reads DB         │
│  └─ Differ        → compares snapshots, emits events     │
│                                                          │
│  Reads from:                                             │
│  └─ Monsthera SQLite DB (read-only, path from MONSTHERA_DB_PATH) │
└──────────────────────────────────────────────────────────┘
```

### Package Scripts Reference

| Package | Script | Command | Description |
|---------|--------|---------|-------------|
| root | `pnpm install` | — | Install all workspace dependencies |
| root | `pnpm build` | — | Build all packages in dependency order |
| root | `pnpm test` | — | Run all tests |
| root | `tsc --build` | — | Typecheck all packages |
| `@monsthera-office/server` | `dev` | `tsx watch src/index.ts` | Start server with hot reload |
| `@monsthera-office/server` | `build` | `tsc -p tsconfig.json` | Compile to JS |
| `@monsthera-office/server` | `start` | `node dist/index.js` | Run compiled server |
| `@monsthera-office/client` | `dev` | `vite` | Start Vite dev server (port 5173) |
| `@monsthera-office/client` | `build` | `vite build` | Build for production |
| `@monsthera-office/client` | `preview` | `vite preview` | Preview production build (port 4173) |
| `@monsthera-office/shared` | `build` | `tsc -p tsconfig.json` | Compile shared types |

### Testing Against a Live Monsthera Instance

The best development experience is to point at an **active Monsthera project** where agents are working:

```bash
# 1. Find the Monsthera DB path for your project
ls /path/to/your-project/.monsthera/monsthera.db

# 2. Start the Monsthera Office server pointed at it
MONSTHERA_DB_PATH=/path/to/your-project/.monsthera/monsthera.db \
  pnpm --filter @monsthera-office/server dev

# 3. Start the client
pnpm --filter @monsthera-office/client dev

# 4. Open http://localhost:5173 in your browser
#    → If Monsthera has active sessions/tickets, the office will be "active"
#    → If no activity, the office will be "closed" (dark, cat sleeping)
```

### Testing with an Empty/Inactive DB

If no active Monsthera project is available, the app still works — it just shows an empty "closed" office:

```bash
# Create a minimal Monsthera DB for testing
mkdir /tmp/test-monsthera && cd /tmp/test-monsthera
git init && monsthera init

# Point the server at it
MONSTHERA_DB_PATH=/tmp/test-monsthera/.monsthera/monsthera.db \
  pnpm --filter @monsthera-office/server dev
```

The office will show:
- Dark night background (#1A1A2E)
- All rooms with lights off
- Cat sleeping at reception
- Magic plant as a seed
- Badge showing "Closed" status
- Zero ticket counters

### Common Development Scenarios

| Scenario | What to do |
|----------|------------|
| Server won't start | Check `MONSTHERA_DB_PATH` exists and is a valid SQLite file |
| Client can't connect to SSE | Verify server is running on port 3001, check CORS_ORIGIN |
| No events appearing | Check if the observed Monsthera project has active agents/tickets |
| "Reconnecting..." overlay | Server crashed or was restarted — client auto-reconnects |
| Types out of sync | Run `pnpm --filter @monsthera-office/shared build` then restart server/client |
| PixiJS changes not reflecting | PixiJS engine changes require manual page refresh (not HMR-compatible) |
| Want to see office "opening" | Register an agent or create a ticket in the observed Monsthera project |

---

## File Map

### `packages/shared/src/`

| File | Responsibility |
|---|---|
| `events.ts` | SSE event type union + payload interfaces (18 event types) |
| `state.ts` | `InitialState` interface for GET /state hydration |
| `rooms.ts` | Room metadata types (id, name, type, capacity, grid position) |
| `constants.ts` | Shared constants (room names, ticket statuses, agent roles, colors) |

### `packages/server/src/`

| File | Responsibility |
|---|---|
| `index.ts` | Express app bootstrap, CORS, routes, start poller |
| `config.ts` | Env var loading + validation (MONSTHERA_DB_PATH, PORT, etc.) |
| `db/reader.ts` | Open SQLite read-only, expose typed query helpers |
| `db/queries.ts` | All SELECT queries against Monsthera tables (agents, sessions, tickets, etc.) |
| `poller/state.ts` | `PollState` interface + initial snapshot factory |
| `poller/differ.ts` | Compare new DB state vs snapshot, emit SSE events for changes |
| `poller/pollLoop.ts` | setInterval loop: read DB → diff → emit → update snapshot |
| `sse/stream.ts` | SSE connection manager (add/remove clients, broadcast) |
| `sse/events.ts` | Event builder functions (DB row → SSE event payload) |
| `routes/state.ts` | GET /state — build InitialState from current DB |
| `routes/rooms.ts` | GET /rooms — static room metadata |
| `routes/health.ts` | GET /health — simple healthcheck |

### `packages/client/src/`

| File | Responsibility |
|---|---|
| `main.tsx` | React entry point, mount App |
| `App.tsx` | Layout: PixiJS canvas + React UI overlay |
| `engine/IsometricWorld.ts` | PixiJS Application wrapper, coordinate system (screen ↔ iso) |
| `engine/TilemapRenderer.ts` | Load + render tile grid with floor, walls, furniture |
| `engine/SpriteManager.ts` | Load spritesheets, create/pool animated sprites |
| `engine/Pathfinding.ts` | A* on isometric grid, waypoint system between rooms |
| `engine/ParticleSystem.ts` | Predefined emitters (sparkles, confetti, hearts, zzZ) |
| `engine/Camera.ts` | Zoom, pan, focus-on-target with easing |
| `characters/Character.ts` | Single character: sprite + state machine + position + animation |
| `characters/CharacterManager.ts` | Create/destroy characters, map agentId → Character, desk assignment |
| `characters/animations.ts` | Animation definitions per state (idle, walk, sit, work, talk, sleep, celebrate) |
| `rooms/RoomBase.ts` | Base class: room bounds, entry point, interactive spots |
| `rooms/Lobby.ts` | Door, reception desk, status board, entry/exit logic |
| `rooms/Desks.ts` | 6 desks, monitor animations, desk assignment round-robin |
| `rooms/Planning.ts` | Kanban board with post-it rendering, slide animations |
| `rooms/Council.ts` | Round table, 5 chairs with badges, verdict animations |
| `rooms/Deploy.ts` | Conveyor belt animation, rocket launch sequence |
| `rooms/Cafeteria.ts` | Tables, coffee machine, idle behaviors, chat bubbles |
| `store/worldStore.ts` | Office lifecycle state, room states, global tick |
| `store/agentStore.ts` | Agent list, positions, current room, assigned tickets |
| `store/uiStore.ts` | Selected agent, panel visibility, event log entries |
| `events/sseClient.ts` | EventSource wrapper with reconnect + backoff |
| `events/eventMapper.ts` | SSE event → Zustand actions (move character, show bubble, etc.) |
| `ui/Sidebar.tsx` | Agent list panel |
| `ui/DetailPanel.tsx` | Selected agent/ticket detail popup |
| `ui/EventLog.tsx` | Scrollable event feed |
| `ui/OfficeBadge.tsx` | Office status indicator + ticket counters |
| `ui/CameraControls.tsx` | Zoom slider, room focus buttons |

### `public/assets/`

| Directory | Contents |
|---|---|
| `sprites/` | Character spritesheets (6 roles x 4 dirs x 7 states) |
| `tiles/` | Floor, wall, furniture, decoration tiles (64x32 iso) |
| `effects/` | Particle textures (star, heart, sparkle, confetti, zzZ) |
| `ui/` | Role badges, model icons, status indicators |

---

## Tasks

Tasks are ordered by dependencies. Tasks with the same dependency depth can be executed in parallel (same wave). Each task includes enough context for an agent to implement it independently.

---

### Task 1: Scaffold monorepo

**Dependencies:** None
**Tags:** `setup`, `infra`
**Severity:** high
**Affected paths:** root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/*/package.json`, `packages/*/tsconfig.json`

**Description:**
Initialize the `monsthera-office` monorepo with pnpm workspaces. Create 3 packages: `shared`, `server`, `client`.

- [ ] **Step 1:** Initialize git repo and root package.json with `"private": true` and `workspaces` field
- [ ] **Step 2:** Create `pnpm-workspace.yaml` with `packages: ["packages/*"]`
- [ ] **Step 3:** Create `tsconfig.base.json` with strict TypeScript config, `"target": "ES2022"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`
- [ ] **Step 4:** Create `packages/shared/package.json` with name `@monsthera-office/shared`, `"type": "module"`, TypeScript dep
- [ ] **Step 5:** Create `packages/shared/tsconfig.json` extending base, `"composite": true`
- [ ] **Step 6:** Create `packages/shared/src/constants.ts` with room names enum, ticket statuses, agent roles, hex colors from spec section 10
- [ ] **Step 7:** Create `packages/server/package.json` with name `@monsthera-office/server`, deps: `express`, `better-sqlite3`, `cors`, `@monsthera-office/shared`. Dev deps: `tsx`, `@types/express`, `@types/better-sqlite3`, `@types/cors`. Scripts: `"dev": "tsx watch src/index.ts"`, `"build": "tsc -p tsconfig.json"`, `"start": "node dist/index.js"`
- [ ] **Step 8:** Create `packages/server/tsconfig.json` extending base, referencing shared
- [ ] **Step 9:** Create `packages/client/package.json` with name `@monsthera-office/client`, deps: `react`, `react-dom`, `pixi.js`, `zustand`, `@monsthera-office/shared`. Dev deps: `vite`, `@vitejs/plugin-react`, `tailwindcss`, `autoprefixer`, `postcss`, `@types/react`, `@types/react-dom`. Scripts: `"dev": "vite"` (port 5173), `"build": "vite build"`, `"preview": "vite preview"` (port 4173)
- [ ] **Step 10:** Create `packages/client/tsconfig.json` extending base, referencing shared
- [ ] **Step 11:** Create `packages/client/vite.config.ts` with React plugin
- [ ] **Step 12:** Create `packages/client/index.html` minimal template
- [ ] **Step 13:** Create `packages/client/src/main.tsx` — renders `<App />` into root
- [ ] **Step 14:** Create `packages/client/src/App.tsx` — placeholder "Monsthera Office" text
- [ ] **Step 15:** Add root `package.json` scripts: `"build": "pnpm --filter @monsthera-office/shared build && pnpm --filter @monsthera-office/server build && pnpm --filter @monsthera-office/client build"`, `"test": "pnpm -r test"`, `"typecheck": "tsc --build"`
- [ ] **Step 16:** Create root `.env.example` documenting all env vars (see Development Setup section above)
- [ ] **Step 17:** Run `pnpm install` and verify all packages resolve
- [ ] **Step 18:** Verify `pnpm --filter @monsthera-office/client dev` starts Vite on http://localhost:5173 and shows placeholder
- [ ] **Step 19:** Commit: `"feat: scaffold monorepo with shared, server, and client packages"`

**Acceptance criteria:**
- `pnpm install` succeeds
- `pnpm --filter @monsthera-office/client dev` starts Vite dev server
- All 3 packages compile with `tsc --build`

---

### Task 2: Shared types — SSE events and state

**Dependencies:** Task 1
**Tags:** `shared`, `types`
**Severity:** medium
**Affected paths:** `packages/shared/src/`

**Description:**
Define all shared TypeScript types used by both server and client. See spec sections 7 (SSE events), 8 (InitialState), 5 (rooms).

- [ ] **Step 1:** Create `packages/shared/src/events.ts` — Define `SSEEvent` base interface and all 18 event types with their payloads as a discriminated union. Event types: `agent:entered`, `agent:left`, `ticket:created`, `ticket:moved`, `ticket:assigned`, `ticket:unassigned`, `ticket:commented`, `verdict:submitted`, `council:assigned`, `council:consensus`, `patch:proposed`, `patch:committed`, `coordination:message`, `wave:advanced`, `job:claimed`, `job:completed`, `convoy:started`, `convoy:completed`. Each with typed payload per spec section 7.
- [ ] **Step 2:** Create `packages/shared/src/state.ts` — Define `InitialState` interface exactly as spec section 8: `office`, `agents[]` (with `currentRoom`, `deskIndex`), `tickets[]`, `councilReviews[]`, `waves`, `stats`.
- [ ] **Step 3:** Create `packages/shared/src/rooms.ts` — Define `RoomId` type (`lobby` | `desks` | `planning` | `council` | `deploy` | `cafeteria`), `RoomMetadata` interface (id, name, capacity, gridPosition).
- [ ] **Step 4:** Update `packages/shared/src/constants.ts` — Add `TICKET_STATUSES`, `AGENT_ROLES`, `SEVERITY_COLORS` (pink=critical, orange=high, yellow=medium, green=low), `OFFICE_STATES`.
- [ ] **Step 5:** Create `packages/shared/src/index.ts` — barrel export all types.
- [ ] **Step 6:** Verify `tsc --build` passes for shared package.
- [ ] **Step 7:** Commit: `"feat(shared): add SSE event types, InitialState, room metadata types"`

**Acceptance criteria:**
- All types compile
- Event union is exhaustive (18 types)
- InitialState matches spec section 8 exactly

---

### Task 3: Backend — Config and SQLite reader

**Dependencies:** Task 1
**Tags:** `backend`, `db`
**Severity:** high
**Affected paths:** `packages/server/src/config.ts`, `packages/server/src/db/`

**Description:**
Implement env var loading with validation and the read-only SQLite connection to Monsthera's DB. See spec sections 11 (config) and 12 (error handling).

- [ ] **Step 1:** Create `packages/server/src/config.ts` — Load and validate env vars: `MONSTHERA_DB_PATH` (required), `PORT` (default 3001), `POLL_INTERVAL_MS` (default 1500), `CORS_ORIGIN` (default `http://localhost:5173`), `MONSTHERA_REPO_ID` (default auto-detect). Throw descriptive error if MONSTHERA_DB_PATH missing or file doesn't exist.
- [ ] **Step 2:** Create `packages/server/src/db/reader.ts` — Open SQLite with `better-sqlite3` in read-only mode (`{ readonly: true, fileMustExist: true }`). Validate expected tables exist (agents, sessions, tickets, ticket_history, dashboard_events). Auto-detect `repoId` from `repos` table if not configured. Export `getDb()` accessor and `getRepoId()`.
- [ ] **Step 3:** Create `packages/server/src/db/queries.ts` — Typed query functions:
  - `getActiveAgents()` — agents with at least 1 active session
  - `getActiveSessions()` — sessions WHERE state='active'
  - `getTicketsByStatus(statuses[])` — tickets filtered by status list
  - `getDashboardEventsAfter(lastId, limit)` — dashboard_events WHERE id > lastId, filtered by repoId
  - `getCouncilAssignmentsAfter(lastId)` — council_assignments WHERE id > lastId
  - `getPatchesAfter(lastId)` — patches WHERE id > lastId
  - `getCoordinationMessagesAfter(lastId)` — coordination_messages WHERE id > lastId
  - `getTicketById(ticketId)` — single ticket lookup for enriching events
  - `getAgentById(agentId)` — single agent lookup
- [ ] **Step 4:** Write tests: config validation (missing path, valid path, defaults), reader opening (mock SQLite file), query return shapes.
- [ ] **Step 5:** Commit: `"feat(server): add config validation and Monsthera SQLite reader"`

**Acceptance criteria:**
- Server exits with clear error message if MONSTHERA_DB_PATH is missing or invalid
- SQLite opens in read-only mode
- All query functions return typed results
- repoId auto-detected from repos table

---

### Task 4: Backend — SSE stream manager

**Dependencies:** Task 2, Task 3
**Tags:** `backend`, `sse`
**Severity:** high
**Affected paths:** `packages/server/src/sse/`

**Description:**
Implement SSE connection management and event broadcasting. See spec section 7.

- [ ] **Step 1:** Create `packages/server/src/sse/stream.ts` — `SSEManager` class:
  - `addClient(res: Response)` — Set SSE headers (`Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`), send initial `:ping`, store client reference. Remove on `req.close`.
  - `broadcast(event: SSEEvent)` — Send to all connected clients as `data: ${JSON.stringify(event)}\n\n`
  - `clientCount` getter
- [ ] **Step 2:** Create `packages/server/src/sse/events.ts` — Builder functions that construct typed `SSEEvent` objects from raw DB data. One function per event type. Each normalizes field names (e.g., Monsthera's `previousStatus` → SSE's `previousStatus`; enriches with JOINed data where needed).
- [ ] **Step 3:** Write tests: SSE headers, client add/remove, broadcast to multiple clients, event builder output shapes.
- [ ] **Step 4:** Commit: `"feat(server): add SSE stream manager and event builders"`

**Acceptance criteria:**
- Multiple clients can connect to SSE
- Client disconnect is handled gracefully
- Events are correctly serialized as SSE format

---

### Task 5: Backend — Poll loop and differ

**Dependencies:** Task 3, Task 4
**Tags:** `backend`, `poller`
**Severity:** high
**Affected paths:** `packages/server/src/poller/`

**Description:**
Implement the core polling loop that reads Monsthera DB changes and emits SSE events. See spec section 6 (change detection strategy).

- [ ] **Step 1:** Create `packages/server/src/poller/state.ts` — `PollState` interface and `createInitialState(db)` factory that reads current cursors (MAX(id) for append-only tables, active session set for mutable tables).
- [ ] **Step 2:** Create `packages/server/src/poller/differ.ts` — `diffAndEmit(db, prevState, sseManager)` function:
  - Query `dashboard_events` WHERE id > lastDashboardEventId → map each to SSE event via event builders (enriching with JOINs when needed)
  - Query `sessions` WHERE state='active' → compare with prevState.activeSessions → emit `agent:entered` / `agent:left`
  - Query `council_assignments` WHERE id > lastCouncilAssignmentId → emit `council:assigned`
  - Query `patches` WHERE id > lastPatchId → emit `patch:proposed` for new ones, detect state changes for `patch:committed`
  - Query `coordination_messages` WHERE id > lastCoordinationMessageId → emit `coordination:message`
  - Return updated `PollState`
- [ ] **Step 3:** Create `packages/server/src/poller/pollLoop.ts` — `startPolling(db, sseManager, intervalMs)` function. Uses `setInterval`. Wraps differ call in try-catch with retry logic for SQLite busy (3 retries with backoff per spec section 12). Logs warnings on failure, skips cycle.
- [ ] **Step 4:** Write tests: differ with mock data (new dashboard event → correct SSE event emitted, new session → agent:entered, session ended → agent:left, new patch → patch:proposed).
- [ ] **Step 5:** Commit: `"feat(server): add poll loop with change detection and SSE emission"`

**Acceptance criteria:**
- Poll loop runs at configured interval
- Dashboard events are correctly mapped to SSE events
- Session changes emit agent:entered / agent:left
- SQLite busy errors are retried, not fatal

---

### Task 6: Backend — REST routes and server bootstrap

**Dependencies:** Task 5
**Tags:** `backend`, `api`
**Severity:** high
**Affected paths:** `packages/server/src/routes/`, `packages/server/src/index.ts`

**Description:**
Implement REST endpoints and wire everything together. See spec sections 8 (GET /state) and 3.1 (REST API).

- [ ] **Step 1:** Create `packages/server/src/routes/health.ts` — `GET /health` returns `{ status: "ok", uptime, clientCount }`
- [ ] **Step 2:** Create `packages/server/src/routes/rooms.ts` — `GET /rooms` returns static room metadata array (6 rooms with id, name, capacity)
- [ ] **Step 3:** Create `packages/server/src/routes/state.ts` — `GET /state` builds `InitialState` from current DB:
  - Query active agents + sessions → compute `currentRoom` per spec section 8 logic (5 priority rules)
  - Query all non-closed tickets
  - Query active council assignments + verdicts grouped by ticket
  - Query active work group wave
  - Compute stats (total, byStatus, resolved count)
  - Assign deskIndex via round-robin for agents in desks
- [ ] **Step 4:** Create `packages/server/src/index.ts` — Express app:
  - Load config via `loadConfig()` — validates MONSTHERA_DB_PATH exists, sets defaults for PORT/POLL_INTERVAL_MS/CORS_ORIGIN
  - Open DB via `createDbReader(config.monstheraDbPath)` — read-only SQLite connection
  - CORS middleware: `cors({ origin: config.corsOrigin })` — default allows `http://localhost:5173` (Vite dev server)
  - Mount routes: `app.get("/health", healthRoute)`, `app.get("/rooms", roomsRoute)`, `app.get("/state", stateRoute)`, `app.get("/events", sseRoute)`
  - Create SSEManager instance, pass to SSE route and poll loop
  - Start poll loop: `startPolling(db, repoId, sseManager, config.pollIntervalMs)`
  - Listen: `app.listen(config.port, () => console.log(...))`
  - Log on startup:
    ```
    Monsthera Office server listening on http://localhost:3001
    Connected to Monsthera DB: /path/to/.monsthera/monsthera.db (repoId: 1)
    Poll loop started (interval: 1500ms)
    SSE endpoint: http://localhost:3001/events
    REST endpoints: /health, /rooms, /state
    ```
  - Graceful shutdown: `process.on("SIGINT", ...)` closes DB and exits
- [ ] **Step 5:** Test locally with a real Monsthera DB:
  ```bash
  MONSTHERA_DB_PATH=/path/to/.monsthera/monsthera.db pnpm --filter @monsthera-office/server dev
  ```
  Verify:
  - Server starts and logs connection info
  - `curl http://localhost:3001/health` → `{ "status": "ok", "uptime": ..., "clientCount": 0 }`
  - `curl http://localhost:3001/rooms` → JSON array with 6 rooms
  - `curl http://localhost:3001/state` → JSON with `office`, `agents`, `tickets`, `stats`
  - `curl -N http://localhost:3001/events` → SSE stream opens, receives ping
- [ ] **Step 6:** Test CORS by opening the Vite client:
  ```bash
  # In another terminal:
  pnpm --filter @monsthera-office/client dev
  # Open http://localhost:5173 — browser console should NOT show CORS errors
  ```
- [ ] **Step 7:** Test error cases:
  - Missing MONSTHERA_DB_PATH → clear error message and exit code 1
  - Invalid SQLite file → clear error message and exit code 1
  - DB locked (another process writing) → retries with backoff, logs warning
- [ ] **Step 8:** Commit: `"feat(server): add REST routes, SSE endpoint, and server bootstrap"`

**Acceptance criteria:**
- `GET /health` returns 200 with `{ status: "ok", uptime, clientCount }`
- `GET /state` returns well-formed `InitialState` matching `@monsthera-office/shared` types
- `GET /events` opens SSE stream (Content-Type: text/event-stream)
- `GET /rooms` returns metadata for 6 rooms
- Server starts cleanly on configured port (default 3001) with valid MONSTHERA_DB_PATH
- CORS allows requests from `http://localhost:5173` (Vite dev server)
- Server exits with clear error if MONSTHERA_DB_PATH is missing or invalid
- Startup logs show: port, DB path, repoId, poll interval, available endpoints

---

### Task 7: Isometric engine — Coordinate system and world

**Dependencies:** Task 1
**Tags:** `frontend`, `engine`
**Severity:** high
**Affected paths:** `packages/client/src/engine/`

**Description:**
Build the core PixiJS isometric engine: coordinate transformations, world container, and camera. See spec sections 3.2 and 5 (layout).

- [ ] **Step 1:** Create `packages/client/src/engine/IsometricWorld.ts`:
  - Initialize PixiJS Application with `{ backgroundAlpha: 1, backgroundColor: 0x1A1A2E }` (night color default)
  - Coordinate conversion functions: `screenToIso(x, y)` and `isoToScreen(col, row)` for 64x32 tile size (standard 2:1 isometric)
  - World container (PixiJS Container) for zoom/pan transforms
  - `addToWorld(displayObject, col, row)` helper that positions at correct screen coordinates
  - Depth sorting: sort children by `(col + row)` for correct overlap
- [ ] **Step 2:** Create `packages/client/src/engine/Camera.ts`:
  - `zoom(scale)` — clamp between 0.5 and 2.0, apply to world container
  - `pan(dx, dy)` — translate world container
  - `focusOn(col, row, duration)` — animate world position to center target tile, ease-out
  - Mouse wheel handler for zoom, click-drag for pan
- [ ] **Step 3:** Integrate into App.tsx — Mount PixiJS canvas, render a test grid (10x10 colored tiles) to verify coordinate system works. Camera zoom/pan should work.
- [ ] **Step 4:** Write test: `isoToScreen` and `screenToIso` roundtrip for known coordinates.
- [ ] **Step 5:** Commit: `"feat(client): add isometric world engine with coordinate system and camera"`

**Acceptance criteria:**
- PixiJS canvas renders in browser
- 10x10 test grid renders in correct isometric projection
- Zoom with scroll wheel works (0.5x–2x)
- Click-drag pan works
- Tiles don't overlap incorrectly (depth sorting)

---

### Task 8: Tilemap renderer

**Dependencies:** Task 7
**Tags:** `frontend`, `engine`
**Severity:** high
**Affected paths:** `packages/client/src/engine/TilemapRenderer.ts`, `public/assets/tiles/`

**Description:**
Render the office tilemap with floor, walls, and room boundaries. See spec sections 5 (layout) and 10 (visual identity).

- [ ] **Step 1:** Create placeholder tile assets in `public/assets/tiles/`:
  - `floor.png` — 64x32 beige diamond tile (#F5E6D3)
  - `wall-left.png`, `wall-right.png` — wall segments
  - `floor-dark.png` — darker variant for night/closed state
  - These can be simple colored shapes initially; pixel art comes later
- [ ] **Step 2:** Create `packages/client/src/engine/TilemapRenderer.ts`:
  - Load tile textures from assets
  - Define office map as 2D array (roughly 30x20 tiles) with room regions:
    - Lobby (bottom-left), Cafeteria (bottom-right)
    - Desks (middle-left), Deploy (middle-right)
    - Planning (top-left), Council (top-right)
    - Hallways connecting them
  - Each cell: `{ type: 'floor' | 'wall' | 'empty', room: RoomId | 'hallway' | null, walkable: boolean }`
  - Render function: iterate map, place correct tile sprite at each iso position
- [ ] **Step 3:** Define room boundaries as named regions: `getRoomBounds(roomId)` returns `{ startCol, startRow, endCol, endRow, entryPoint: {col, row} }`
- [ ] **Step 4:** Add room labels (PixiJS Text) floating above each room area
- [ ] **Step 5:** Replace test grid in App.tsx with full office tilemap
- [ ] **Step 6:** Commit: `"feat(client): add tilemap renderer with office layout and room regions"`

**Acceptance criteria:**
- Full office renders with 6 distinct room areas + hallways
- Rooms are visually distinguishable
- Room labels visible
- Camera zoom/pan still work on the full map

---

### Task 9: Sprite manager and character animations

**Dependencies:** Task 7
**Tags:** `frontend`, `engine`, `characters`
**Severity:** high
**Affected paths:** `packages/client/src/engine/SpriteManager.ts`, `packages/client/src/characters/`, `public/assets/sprites/`

**Description:**
Build the sprite loading system and character animation state machine. See spec sections 9 (characters) and 10 (animations).

- [ ] **Step 1:** Create placeholder character spritesheets in `public/assets/sprites/`:
  - `developer.png` — 48x48 frames, 4 directions x basic states (at minimum: idle 2f, walk 4f). Can be simple colored circles with directional arrows initially.
  - Create a spritesheet JSON manifest (PixiJS Spritesheet format) describing frame positions.
  - One spritesheet per role initially, can use same placeholder for all.
- [ ] **Step 2:** Create `packages/client/src/engine/SpriteManager.ts`:
  - Load spritesheets via PixiJS Assets
  - `createCharacterSprite(role)` — returns AnimatedSprite configured for the role
  - `getAnimation(role, state, direction)` — returns frame array for given state+direction
  - Sprite pool: reuse sprites when characters leave
- [ ] **Step 3:** Create `packages/client/src/characters/animations.ts`:
  - Define animation configs: `{ state: string, frames: number, speed: number, loop: boolean }`
  - States: idle (2f, loop), walk (4f, loop), sit (2f, no-loop), work (3f, loop), talk (2f, loop), sleep (2f, loop), celebrate (3f, no-loop)
  - Bouncy walk: add y-offset oscillation (+/- 2px per frame)
- [ ] **Step 4:** Create `packages/client/src/characters/Character.ts`:
  - Properties: `agentId`, `name`, `role`, `position: {col, row}`, `targetPosition`, `currentState`, `currentRoom`, `sprite`
  - State machine: `setState(newState)` — transitions animation
  - `moveTo(col, row)` — sets target, switches to walk state, interpolates position each frame
  - `update(deltaTime)` — advance position toward target, switch to idle when arrived
  - `setDirection(dir)` — update sprite direction based on movement vector
- [ ] **Step 5:** Create `packages/client/src/characters/CharacterManager.ts`:
  - `addCharacter(agentId, name, role, room)` — create Character, place at room entry point
  - `removeCharacter(agentId)` — animate exit, then destroy
  - `getCharacter(agentId)` → Character | undefined
  - `updateAll(deltaTime)` — update all characters
  - Desk assignment: `assignDesk(agentId)` → round-robin from available desks (6 total)
  - Map of `agentId → Character`
- [ ] **Step 6:** Test: render 2-3 test characters on the tilemap, verify they walk between rooms, animate correctly, depth-sort properly.
- [ ] **Step 7:** Commit: `"feat(client): add sprite system, character state machine, and character manager"`

**Acceptance criteria:**
- Characters render as animated sprites on the isometric world
- Walk animation plays with bouncy effect
- Characters correctly move to target positions
- Direction changes based on movement vector
- Multiple characters depth-sort correctly

---

### Task 10: Pathfinding

**Dependencies:** Task 8, Task 9
**Tags:** `frontend`, `engine`
**Severity:** medium
**Affected paths:** `packages/client/src/engine/Pathfinding.ts`

**Description:**
A* pathfinding on the isometric grid with waypoints between rooms. See spec section 3.2.

- [ ] **Step 1:** Create `packages/client/src/engine/Pathfinding.ts`:
  - A* implementation on 2D grid using the tilemap walkability data
  - `findPath(fromCol, fromRow, toCol, toRow)` → `Array<{col, row}>`
  - Heuristic: Manhattan distance on grid
  - Neighbors: 4-directional (N, S, E, W) — not diagonal for isometric clarity
- [ ] **Step 2:** Add waypoint system:
  - `getPathBetweenRooms(fromRoom, toRoom)` — returns predefined waypoint path via hallways
  - Waypoints: room exit → hallway → room entry → position inside room
  - Pre-compute room-to-room paths at startup for common transitions
- [ ] **Step 3:** Integrate with `Character.moveTo()` — character follows path nodes sequentially
- [ ] **Step 4:** Test: character walks from Lobby to Desks following hallway path, not through walls.
- [ ] **Step 5:** Commit: `"feat(client): add A* pathfinding with room-to-room waypoints"`

**Acceptance criteria:**
- Characters navigate between rooms via hallways
- No walking through walls or furniture
- Path is visually smooth (character changes direction at waypoints)

---

### Task 11: Particle system

**Dependencies:** Task 7
**Tags:** `frontend`, `engine`, `effects`
**Severity:** medium
**Affected paths:** `packages/client/src/engine/ParticleSystem.ts`, `public/assets/effects/`

**Description:**
Predefined particle emitters for cute visual effects. See spec section 10.

- [ ] **Step 1:** Create particle texture assets in `public/assets/effects/`:
  - `star.png` — 8x8 yellow star
  - `heart.png` — 8x8 pink heart
  - `sparkle.png` — 6x6 white sparkle
  - `confetti-red.png`, `confetti-blue.png`, `confetti-yellow.png` — 4x8 rectangles
  - `zzz.png` — 12x8 "Z" letter
- [ ] **Step 2:** Create `packages/client/src/engine/ParticleSystem.ts`:
  - `emitAt(type, col, row, options?)` — spawn particles at world position
  - Predefined types:
    - `sparkle` — 5-8 sparkles, float up, fade out, 1s duration
    - `confetti` — 20-30 pieces, burst up then fall, 2s duration
    - `hearts` — 3-5 hearts, float up slowly, 1.5s
    - `zzz` — single Z, float up-right, loop, attached to character
    - `storm-cloud` — dark puff above character (for blocked state)
    - `alert` — exclamation mark popup (for task received in cafeteria)
  - Each particle: PixiJS Sprite with velocity, gravity, alpha fade, rotation
  - `update(deltaTime)` — advance all active particles, remove dead ones
- [ ] **Step 3:** Test: trigger each particle type on click at cursor position.
- [ ] **Step 4:** Commit: `"feat(client): add particle system with sparkles, confetti, hearts, and zzZ"`

**Acceptance criteria:**
- Each particle type visually distinct
- Particles animate smoothly (float, fade, fall)
- Particles auto-cleanup after lifetime expires

---

### Task 12: Zustand stores

**Dependencies:** Task 2
**Tags:** `frontend`, `state`
**Severity:** medium
**Affected paths:** `packages/client/src/store/`

**Description:**
Create Zustand stores that hold all app state. See spec sections 4 (office lifecycle), 8 (state shape).

- [ ] **Step 1:** Create `packages/client/src/store/worldStore.ts`:
  - State: `officeStatus` ('closed' | 'opening' | 'active' | 'closing'), `ticketsByStatus` (Record), `totalResolved`, `activeWave`
  - Actions: `setOfficeStatus()`, `updateTicketStats()`, `setWave()`
  - Office status transition logic per spec section 4
- [ ] **Step 2:** Create `packages/client/src/store/agentStore.ts`:
  - State: `agents` Map<agentId, AgentState>, where AgentState = { name, role, model, currentRoom, ticketId, ticketTitle, deskIndex }
  - Actions: `addAgent()`, `removeAgent()`, `moveAgent(agentId, room)`, `assignTicket(agentId, ticketId, title)`, `unassignTicket(agentId)`
- [ ] **Step 3:** Create `packages/client/src/store/uiStore.ts`:
  - State: `selectedAgentId`, `isPanelOpen`, `eventLog` (Array, max 100 entries), `isReconnecting`
  - Actions: `selectAgent()`, `clearSelection()`, `addEvent()`, `setReconnecting()`
- [ ] **Step 4:** Commit: `"feat(client): add Zustand stores for world, agent, and UI state"`

**Acceptance criteria:**
- Stores compile and export correctly
- Office status transitions follow spec section 4 rules
- Event log caps at 100 entries (FIFO)

---

### Task 13: SSE client and event mapper

**Dependencies:** Task 6, Task 12
**Tags:** `frontend`, `events`, `integration`
**Severity:** high
**Affected paths:** `packages/client/src/events/`

**Description:**
Connect frontend to backend SSE stream and map events to Zustand store actions. See spec sections 7 and 12 (reconnection).

- [ ] **Step 1:** Create `packages/client/src/events/sseClient.ts`:
  - `connectSSE(url)` — Create EventSource, parse incoming events as JSON
  - Reconnect with exponential backoff: 1s, 2s, 4s, 8s, max 30s (spec section 12)
  - On disconnect: set `uiStore.setReconnecting(true)`, show overlay
  - On reconnect: fetch `GET /state` to re-hydrate all stores, then resume SSE
  - `disconnect()` — close EventSource
- [ ] **Step 2:** Create `packages/client/src/events/eventMapper.ts`:
  - `handleEvent(event: SSEEvent)` — switch on event type, call appropriate store actions:
    - `agent:entered` → `agentStore.addAgent()`, trigger character spawn
    - `agent:left` → `agentStore.removeAgent()`, trigger character exit
    - `ticket:created` → `worldStore.updateTicketStats()`, add to event log
    - `ticket:moved` → update ticket stats, move character to appropriate room
    - `ticket:assigned` → `agentStore.assignTicket()`, move character to desks
    - `ticket:unassigned` → `agentStore.unassignTicket()`, move character to cafeteria
    - `verdict:submitted` → trigger verdict animation on character
    - `council:assigned` → move character to council room
    - (etc. for all 18 event types)
  - Each handler also calls `uiStore.addEvent()` with human-readable summary
- [ ] **Step 3:** Create hydration function `hydrateFromState(state: InitialState)`:
  - Set office status
  - Add all agents to agentStore with correct rooms
  - Update ticket stats
  - Set council reviews
  - Set wave info
- [ ] **Step 4:** Wire into App.tsx: on mount, fetch `/state` → hydrate → connect SSE
- [ ] **Step 5:** Test end-to-end: start server with real Monsthera DB, start client, verify events appear in console and stores update.
- [ ] **Step 6:** Commit: `"feat(client): add SSE client with reconnection and event-to-store mapping"`

**Acceptance criteria:**
- Client connects to SSE on mount
- Events update Zustand stores in real time
- Reconnection works with backoff
- Initial state hydration populates all stores correctly

---

### Task 14: Room implementations

**Dependencies:** Task 8, Task 9, Task 10, Task 11
**Tags:** `frontend`, `rooms`
**Severity:** high
**Affected paths:** `packages/client/src/rooms/`

**Description:**
Implement room-specific behavior and furniture. See spec section 5 (all 6 rooms).

- [ ] **Step 1:** Create `packages/client/src/rooms/RoomBase.ts`:
  - Base class with: `roomId`, `bounds`, `entryPoint`, `interactiveSpots` (named positions within room)
  - `getAvailableSpot()` — next unoccupied interactive spot
  - `onCharacterEnter(character)` / `onCharacterLeave(character)`
  - `setLightState(on: boolean)` — toggle room brightness (tint overlay)
- [ ] **Step 2:** Create `Lobby.ts` — Door sprite (open/close animation), reception desk, status board sprite showing ticket counts. `onCharacterEnter`: brief pause at desk.
- [ ] **Step 3:** Create `Desks.ts` — 6 desk positions with PC sprites. Each desk has: monitor sprite (on/off states), chair, coffee cup. `assignDesk(agentId)` round-robin. Monitor shows "code" animation (green text flicker) when occupied.
- [ ] **Step 4:** Create `Planning.ts` — Kanban board sprite with 3 columns. Post-it sprites positioned in columns by ticket status. `addPostIt(ticketId, title, severity)` with bounce animation. `movePostIt(ticketId, toColumn)` with slide animation. `removePostIt(ticketId)` with fly-out animation.
- [ ] **Step 5:** Create `Council.ts` — Round table, 5 chairs with specialization badges (security, performance, architect, patterns, simplifier as small icon sprites). Screen sprite on wall. `showReview(ticketTitle)` → screen turns on. `showVerdict(agentId, verdict)` → thumbs up/down sprite above chair. `celebrate()` → confetti particle burst.
- [ ] **Step 6:** Create `Deploy.ts` — Conveyor belt (scrolling texture), rocket sprite, "Completed" counter text. `addPackage(ticketId)` → small box sprite on belt start. `launchRocket()` → rocket moves up with sparkle trail, counter increments.
- [ ] **Step 7:** Create `Cafeteria.ts` — Tables, coffee machine sprite, donut shelf. `sitIdle(character)` → character at table. After 30s idle → zzZ particles. `showChatBubble(agentId, text)` → floating text bubble near character.
- [ ] **Step 8:** Integrate all rooms into IsometricWorld — instantiate each, position at correct tilemap regions. Wire room light states to office lifecycle.
- [ ] **Step 9:** Test: manually trigger room behaviors (add post-it, show verdict, launch rocket) to verify animations.
- [ ] **Step 10:** Commit: `"feat(client): implement all 6 office rooms with furniture and behaviors"`

**Acceptance criteria:**
- All 6 rooms render with furniture
- Room-specific animations work (post-its, verdicts, rocket)
- Lights toggle on/off with office lifecycle
- Characters can enter/leave rooms correctly

---

### Task 15: Office lifecycle manager

**Dependencies:** Task 13, Task 14
**Tags:** `frontend`, `integration`
**Severity:** medium
**Affected paths:** `packages/client/src/engine/IsometricWorld.ts` (modify), `packages/client/src/store/worldStore.ts` (modify)

**Description:**
Implement the office open/close lifecycle with light animations. See spec section 4.

- [ ] **Step 1:** Add office lifecycle to `worldStore.ts`:
  - `computeOfficeStatus(agents, tickets)` — determines status based on active sessions + active tickets per spec section 4 rules
  - Called on every agent:entered, agent:left, ticket:moved event
- [ ] **Step 2:** Add to `IsometricWorld.ts`:
  - `transitionToOpening()` — animate lights on room by room (lobby → planning → desks → council → deploy → cafeteria), 500ms per room, change background from night (#1A1A2E) to day tint
  - `transitionToClosing()` — reverse: rooms darken as agents leave, background fades to night
  - `transitionToClosed()` — all rooms dark, night background
  - `transitionToActive()` — all rooms lit, warm background
- [ ] **Step 3:** Subscribe worldStore to trigger transitions on status change.
- [ ] **Step 4:** Test: start with empty Monsthera → office closed. Create a session → office opens. End session → office closes.
- [ ] **Step 5:** Commit: `"feat(client): add office lifecycle with light-on/off transitions"`

**Acceptance criteria:**
- Office starts dark when no agents/tickets
- Lights animate on sequentially when first agent arrives
- Lights animate off when last agent leaves
- Background color transitions smoothly

---

### Task 16: React UI overlay

**Dependencies:** Task 12, Task 13
**Tags:** `frontend`, `ui`
**Severity:** medium
**Affected paths:** `packages/client/src/ui/`

**Description:**
Build the React UI components that overlay the PixiJS canvas. See spec section 3.3.

- [ ] **Step 1:** Setup Tailwind CSS in client package. Configure with spec section 10 colors.
- [ ] **Step 2:** Create `packages/client/src/ui/OfficeBadge.tsx` — Top-left badge showing: office status (closed/active with colored dot), ticket counters by status (backlog: N, in_progress: N, in_review: N, resolved: N). Reads from worldStore.
- [ ] **Step 3:** Create `packages/client/src/ui/Sidebar.tsx` — Right sidebar, collapsible. Shows list of active agents: pixel art avatar (colored circle matching role), name, role badge, current room, assigned ticket title. Click → selectAgent. Reads from agentStore.
- [ ] **Step 4:** Create `packages/client/src/ui/DetailPanel.tsx` — Popup panel when agent selected. Shows: agent name, role, model, current ticket (id, title, status, severity), time in current status. Close button. Reads from agentStore + uiStore.
- [ ] **Step 5:** Create `packages/client/src/ui/EventLog.tsx` — Bottom panel, collapsible. Scrollable list of recent events with: timestamp, icon (per event type), description text. Auto-scrolls to bottom on new event. Reads from uiStore.eventLog.
- [ ] **Step 6:** Create `packages/client/src/ui/CameraControls.tsx` — Bottom-right floating controls: zoom slider (0.5x–2x), buttons to focus on each room (6 room buttons with icons). Calls Camera methods.
- [ ] **Step 7:** Update `App.tsx` — Layer UI components over PixiJS canvas using absolute positioning. CSS: `pointer-events: none` on overlay container, `pointer-events: auto` on interactive elements.
- [ ] **Step 8:** Style everything with pixel art friendly typography, rounded borders, pastel colors per spec section 10.
- [ ] **Step 9:** Commit: `"feat(client): add React UI overlay with sidebar, event log, and camera controls"`

**Acceptance criteria:**
- UI overlays PixiJS canvas without blocking canvas interactions
- Sidebar shows agent list with real-time updates
- Event log scrolls and caps at 100 entries
- Camera controls affect the isometric world
- Styling matches spec pastel/cute aesthetic

---

### Task 17: Wire everything — Full integration

**Dependencies:** Task 13, Task 14, Task 15, Task 16
**Tags:** `frontend`, `integration`
**Severity:** high
**Affected paths:** `packages/client/src/events/eventMapper.ts` (modify), `packages/client/src/App.tsx` (modify)

**Description:**
Connect SSE events to character movements, room behaviors, and particle effects. This is where the world comes alive.

- [ ] **Step 1:** Update `eventMapper.ts` — For each event, trigger BOTH store actions AND visual actions:
  - `agent:entered` → agentStore.addAgent() + CharacterManager.addCharacter() at lobby, animate walk to correct room
  - `agent:left` → animate character walk to lobby, then CharacterManager.removeCharacter()
  - `ticket:moved` → character walks to new room based on newStatus mapping:
    - `in_progress` → desks (assignDesk)
    - `in_review` → council (if reviewer) or idle
    - `ready_for_commit` → deploy room adds package
    - `resolved` → deploy room launches rocket
    - `blocked` → storm-cloud particle on character
  - `verdict:submitted` → Council.showVerdict() + particle (sparkles or storm)
  - `council:consensus` → Council.celebrate() + confetti particles
  - `patch:proposed` → paper-fly animation from desk
  - `coordination:message` → Cafeteria.showChatBubble()
  - `convoy:started` → trigger office opening if closed
  - `convoy:completed` → sparkles everywhere + office closing sequence
- [ ] **Step 2:** Add game loop in App.tsx: `PixiJS.Ticker` calling `CharacterManager.updateAll()`, `ParticleSystem.update()`, depth-sort world children each frame.
- [ ] **Step 3:** Add click handler on characters: click character sprite → uiStore.selectAgent() → DetailPanel shows.
- [ ] **Step 4:** Full end-to-end test:
  - Start server pointing at Monsthera DB with active agents
  - Start client
  - Verify: office opens, characters appear, walk to rooms, events trigger animations
  - Create a ticket in Monsthera → post-it appears on planning board
  - Assign ticket → character walks to desk
- [ ] **Step 5:** Commit: `"feat: wire SSE events to character movements, room behaviors, and particles"`

**Acceptance criteria:**
- Characters react to every SSE event type with appropriate movement/animation
- Room furniture reacts (monitors turn on, post-its move, rocket launches)
- Particles fire on appropriate events
- Clicking a character opens detail panel
- The office feels alive when Monsthera is active

---

### Task 18: Easter eggs — Cat and magic plant

**Dependencies:** Task 17
**Tags:** `frontend`, `easter-egg`
**Severity:** low
**Affected paths:** `packages/client/src/characters/` (modify), `packages/client/src/rooms/` (modify)

**Description:**
Add the office cat NPC and magic plant. See spec section 10 (easter eggs).

- [ ] **Step 1:** Create cat character (NPC, not tied to any agent):
  - Roams toward the room with most characters
  - Sleeps in lobby when office is closed (zzZ particles)
  - Occasionally sits on a random developer's desk (special sit animation)
  - Small chibi cat sprite (32x32)
- [ ] **Step 2:** Create magic plant in lobby:
  - 4 sprite states: seed, sprout, plant, flower
  - Grows based on `totalResolved`: 0 = seed, 5 = sprout, 15 = plant, 30 = flower
  - Wilts (brown tint + droopy sprite) if > 3 blocked tickets simultaneously
  - Recovers when blocked count drops
- [ ] **Step 3:** Commit: `"feat: add office cat and magic plant easter eggs"`

**Acceptance criteria:**
- Cat moves toward active rooms
- Cat sleeps when office is closed
- Plant grows with resolved tickets
- Plant wilts with blocked tickets

---

### Task 19: Pixel art assets (placeholder → final)

**Dependencies:** Task 17
**Tags:** `frontend`, `art`
**Severity:** medium
**Affected paths:** `public/assets/`

**Description:**
Replace placeholder sprites with cute pixel art. This task can be done by a human artist or AI image generation, then integrated.

- [ ] **Step 1:** Create tile assets — Floor tiles (beige diamond 64x32), wall segments, hallway tiles. All with soft pastel colors per spec.
- [ ] **Step 2:** Create furniture sprites — Desks with PCs, chairs, reception desk, kanban board, round table, conveyor belt, rocket, coffee machine, donut shelf. Rounded edges, pastel colors, plants with faces.
- [ ] **Step 3:** Create character spritesheets — 6 role variants, 4 directions, 7 animation states. Chibi style: big heads, small bodies, expressive eyes. 48x48 per frame.
- [ ] **Step 4:** Create particle textures — Star, heart, sparkle, confetti pieces, zzZ. Cute, small, colorful.
- [ ] **Step 5:** Create UI assets — Role badges (laptop, magnifier, megaphone, clipboard, binoculars, crown), model badges (opus, sonnet, haiku icons), status indicators.
- [ ] **Step 6:** Update SpriteManager to load final spritesheets. Verify all animations play correctly with new assets.
- [ ] **Step 7:** Commit: `"art: replace placeholder sprites with pixel art assets"`

**Acceptance criteria:**
- All placeholder colored shapes replaced with pixel art
- Chibi characters have distinct visual identity per role
- Aesthetic matches spec section 10 (pastel, cute, rounded)
- All animations still work with new frame dimensions

---

### Task 20: Polish and QA

**Dependencies:** Task 17, Task 18, Task 19
**Tags:** `qa`, `polish`
**Severity:** medium
**Affected paths:** various

**Description:**
Final polish pass: fix visual bugs, tune animations, optimize performance.

- [ ] **Step 1:** Performance audit: ensure 60fps with 10+ characters. Profile PixiJS render loop, optimize depth sorting (don't sort every frame — only when characters move). Sprite batching.
- [ ] **Step 2:** Tune animation timings: walk speed, camera easing, particle lifetimes, room transition durations. Make everything feel "bouncy and cute".
- [ ] **Step 3:** Test reconnection: kill server while client is running → "Reconnecting..." overlay appears → restart server → client re-hydrates and resumes.
- [ ] **Step 4:** Test with empty Monsthera DB (no agents, no tickets) → office should show in closed state, dark, cat sleeping.
- [ ] **Step 5:** Test with active convoy: launch a convoy on a real Monsthera project → watch office come alive, characters move through rooms, tickets flow through pipeline.
- [ ] **Step 6:** Add README.md with setup instructions: prerequisites, env vars, how to start both server and client, link to Monsthera.
- [ ] **Step 7:** Commit: `"chore: polish animations, optimize performance, add README"`

**Acceptance criteria:**
- 60fps with 10+ characters on screen
- Animations feel smooth and cute
- Reconnection works seamlessly
- Empty state and active state both look correct
- README allows new developer to set up in < 5 minutes

---

## Dependency Graph

```
Task 1 (scaffold)
├── Task 2 (shared types)
│   └── Task 12 (Zustand stores)
│       └── Task 16 (React UI)
├── Task 3 (backend config + DB)
│   ├── Task 4 (SSE stream)
│   │   └── Task 5 (poll loop)
│   │       └── Task 6 (REST routes + bootstrap)
│   │           └── Task 13 (SSE client + event mapper) ← also needs Task 12
│   └── Task 5
├── Task 7 (isometric engine)
│   ├── Task 8 (tilemap)
│   │   └── Task 10 (pathfinding) ← also needs Task 9
│   ├── Task 9 (sprites + characters)
│   │   └── Task 10
│   └── Task 11 (particles)
│
├── Task 14 (rooms) ← needs Task 8, 9, 10, 11
│   └── Task 15 (office lifecycle) ← also needs Task 13
│       └── Task 17 (full integration) ← needs Task 13, 14, 15, 16
│           ├── Task 18 (easter eggs)
│           ├── Task 19 (pixel art)
│           └── Task 20 (polish) ← needs 17, 18, 19
```

## Expected Waves (computed by `compute_waves`)

The actual waves will be determined by Monsthera's `compute_waves` based on the dependency DAG above. Expected grouping:

| Wave | Tasks | Rationale |
|---|---|---|
| 1 | Task 1 | Foundation — everything depends on this |
| 2 | Task 2, Task 3, Task 7 | Independent: shared types, backend DB, frontend engine |
| 3 | Task 4, Task 8, Task 9, Task 11, Task 12 | SSE manager, tilemap, sprites, particles, stores — all independent |
| 4 | Task 5, Task 10, Task 16 | Poll loop needs SSE, pathfinding needs tilemap+sprites, UI needs stores |
| 5 | Task 6, Task 14 | REST routes need poller, rooms need tilemap+sprites+particles+pathfinding |
| 6 | Task 13, Task 15 | SSE client needs server+stores, lifecycle needs rooms+events |
| 7 | Task 17 | Full integration — needs everything |
| 8 | Task 18, Task 19 | Easter eggs and art — independent, both need integration |
| 9 | Task 20 | Final polish |

---

## Monsthera Ticket Generation Guide

When an agent uses this plan to create tickets via `decompose_goal`, map each task as follows:

```
For each Task N:
  title:              Task title (e.g., "Scaffold monorepo with pnpm workspaces")
  description:        Task description paragraph + key steps summary
  affectedPaths:      Files listed in "Affected paths"
  tags:               Tags listed in task header
  severity:           Severity listed in task header
  acceptanceCriteria: "Acceptance criteria" section of the task
  dependsOn:          [indices of dependency tasks]
```

The `decompose_goal` tool validates the DAG and creates tickets with `blocks`/`blocked_by` links automatically.

After tickets are created:
1. `create_work_group(title: "Monsthera Office v1", description: "Full-stack isometric office visualization for Monsthera")`
2. `add_tickets_to_group(groupId, ticketIds)` — add all 20 tickets
3. `compute_waves(groupId)` — Monsthera computes optimal parallelization
4. `launch_convoy(groupId)` — execute wave by wave with agents
