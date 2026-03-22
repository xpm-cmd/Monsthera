# Monsthera Office — Ticket Manifest

> **For an Monsthera agent:** This document contains all tickets needed to build Monsthera Office. Use `decompose_goal` with `dryRun: false` to create them, then `create_work_group`, `add_tickets_to_group`, `compute_waves`, and `launch_convoy`.

**Spec:** `docs/superpowers/specs/2026-03-17-monsthera-office-design.md`
**Plan:** `docs/superpowers/plans/2026-03-17-monsthera-office.md`

---

## Features

| # | Feature | Tickets | Description |
|---|---|---|---|
| F1 | Infrastructure | T01 | Monorepo scaffold with pnpm workspaces |
| F2 | Shared types | T02 | Shared TypeScript types between server and client |
| F3 | Backend | T03, T04, T05, T06 | Express server reading Monsthera DB and emitting SSE |
| F4 | Isometric engine | T07, T08, T09, T10, T11 | Core PixiJS rendering engine |
| F5 | Rooms | T14 | 6 office rooms with behavior |
| F6 | State and UI | T12, T16 | Zustand stores + React overlay |
| F7 | Data integration | T13, T15, T17 | SSE connection → visual world |
| F8 | Polish | T18, T19, T20 | Easter eggs, final art, QA |

---

## Tickets

### T01 — Scaffold monorepo with pnpm workspaces

- **severity:** high
- **priority:** 10
- **tags:** `setup`, `infra`
- **dependsOn:** (none)
- **affectedPaths:** `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `packages/shared/`, `packages/server/`, `packages/client/`
- **acceptanceCriteria:**
  - `pnpm install` runs without errors
  - `pnpm --filter @monsthera-office/client dev` starts Vite and shows placeholder
  - `tsc --build` compiles all 3 packages without errors
- **description:** Initialize the `monsthera-office` monorepo with pnpm workspaces. Create 3 packages: `shared` (shared types), `server` (Node+Express), `client` (React+PixiJS+Vite). Configure strict TypeScript, project references, and dev scripts. The `shared` package must have `constants.ts` with room name enums, ticket statuses, roles, and hex colors from the pastel palette (spec section 10).

---

### T02 — Shared types: SSE events, InitialState, rooms

- **severity:** medium
- **priority:** 8
- **tags:** `shared`, `types`
- **dependsOn:** [T01]
- **affectedPaths:** `packages/shared/src/events.ts`, `packages/shared/src/state.ts`, `packages/shared/src/rooms.ts`, `packages/shared/src/index.ts`
- **acceptanceCriteria:**
  - Discriminated union of 18 SSE event types with typed payloads
  - `InitialState` interface matches spec section 8 (including `councilReviews` as array)
  - `RoomId` type with 6 rooms
  - `tsc --build` passes
- **description:** Define all shared TypeScript types between server and client. SSE events (spec section 7): `agent:entered`, `agent:left`, `ticket:created`, `ticket:moved`, `ticket:assigned`, `ticket:unassigned`, `ticket:commented`, `verdict:submitted`, `council:assigned`, `council:consensus`, `patch:proposed`, `patch:committed`, `coordination:message`, `wave:advanced`, `job:claimed`, `job:completed`, `convoy:started`, `convoy:completed`. `InitialState` interface (spec section 8) with office status, agents with currentRoom, tickets, councilReviews array, waves, stats. Room metadata types.

---

### T03 — Backend: config and SQLite reader

- **severity:** high
- **priority:** 9
- **tags:** `backend`, `db`
- **dependsOn:** [T01]
- **affectedPaths:** `packages/server/src/config.ts`, `packages/server/src/db/reader.ts`, `packages/server/src/db/queries.ts`
- **acceptanceCriteria:**
  - Server exits with clear error if `MONSTHERA_DB_PATH` doesn't exist or is invalid
  - SQLite opens in read-only mode
  - All query functions return typed results
  - `repoId` auto-detected from `repos` table
- **description:** Implement env var loading and validation (spec section 11): `MONSTHERA_DB_PATH` (required), `PORT` (default 3001), `POLL_INTERVAL_MS` (default 1500), `CORS_ORIGIN` (default localhost:5173), `MONSTHERA_REPO_ID` (default auto-detect). Open SQLite with `better-sqlite3` in read-only mode. Validate expected tables exist. Implement typed query functions: `getActiveAgents()`, `getActiveSessions()`, `getTicketsByStatus()`, `getDashboardEventsAfter(lastId)`, `getCouncilAssignmentsAfter(lastId)`, `getPatchesAfter(lastId)`, `getCoordinationMessagesAfter(lastId)`, `getTicketById()`, `getAgentById()`. Reference: schema in spec section 16.

---

### T04 — Backend: SSE stream manager

- **severity:** high
- **priority:** 8
- **tags:** `backend`, `sse`
- **dependsOn:** [T02, T03]
- **affectedPaths:** `packages/server/src/sse/stream.ts`, `packages/server/src/sse/events.ts`
- **acceptanceCriteria:**
  - Multiple SSE clients can connect simultaneously
  - Client disconnection is handled without crash
  - Events are correctly serialized as `data: JSON\n\n`
  - Event builders produce payloads matching shared types
- **description:** Implement `SSEManager` class: `addClient(res)` sets SSE headers (Content-Type: text/event-stream, Cache-Control: no-cache, Connection: keep-alive), sends initial ping, stores reference and cleans up on `req.close`. `broadcast(event)` sends to all connected clients. Implement event builder functions that construct typed `SSEEvent` objects from raw DB data, normalizing field names (e.g., Monsthera uses `previousStatus`, SSE uses `previousStatus`). Note: Monsthera events are now enriched with all needed fields (`ticket_created` includes `title`, `ticket_commented` includes `contentPreview`), so no JOINs are needed for most events.

---

### T05 — Backend: poll loop and differ

- **severity:** high
- **priority:** 8
- **tags:** `backend`, `poller`
- **dependsOn:** [T03, T04]
- **affectedPaths:** `packages/server/src/poller/state.ts`, `packages/server/src/poller/differ.ts`, `packages/server/src/poller/pollLoop.ts`
- **acceptanceCriteria:**
  - Poll loop runs at configured interval
  - Dashboard events are correctly mapped to SSE events
  - Session changes emit `agent:entered` / `agent:left`
  - SQLite busy errors are retried (3 times with backoff), not fatal
- **description:** Implement the core polling engine (spec section 6). `PollState` with cursors: `lastDashboardEventId` and `lastCouncilAssignmentId` (only council_assignments lacks a dashboard event — agents, sessions, patches, and coordination are now covered by dashboard events). `createInitialState(db)` factory that reads current cursors. `diffAndEmit(db, prevState, sseManager)` that: (1) reads `dashboard_events` WHERE id > cursor → maps to SSE events (including `agent_registered` → `agent:entered`, `session_changed` → `agent:left`, `patch_proposed` → `patch:proposed`, `coordination_message_sent` → `coordination:message`), (2) reads new council_assignments → emits `council:assigned`. `startPolling` with setInterval and try-catch with retry for SQLite busy (spec section 12). Filter dashboard_events by `repo_id` (spec section 6).

---

### T06 — Backend: REST routes and server bootstrap

- **severity:** high
- **priority:** 7
- **tags:** `backend`, `api`
- **dependsOn:** [T05]
- **affectedPaths:** `packages/server/src/routes/`, `packages/server/src/index.ts`
- **acceptanceCriteria:**
  - `GET /health` returns 200 with status and clientCount
  - `GET /state` returns well-formed `InitialState`
  - `GET /events` opens SSE stream
  - `GET /rooms` returns metadata for 6 rooms
  - Server starts cleanly with valid MONSTHERA_DB_PATH
- **description:** Implement REST routes. `GET /health`: `{ status: "ok", uptime, clientCount }`. `GET /rooms`: static array with metadata for 6 rooms (id, name, capacity). `GET /state`: build `InitialState` (spec section 8) — query active agents with sessions, compute `currentRoom` using 5 priority rules (in_progress→desks, council_assignment→council, planner/facilitator→planning, active_no_ticket→cafeteria, inactive→null), assign deskIndex round-robin, query non-closed tickets, active council reviews, current wave, stats. `index.ts`: Express app with CORS, mount routes, create SSEManager, start poll loop, listen on PORT.

---

### T07 — Isometric engine: coordinate system and world

- **severity:** high
- **priority:** 9
- **tags:** `frontend`, `engine`
- **dependsOn:** [T01]
- **affectedPaths:** `packages/client/src/engine/IsometricWorld.ts`, `packages/client/src/engine/Camera.ts`
- **acceptanceCriteria:**
  - PixiJS canvas renders in browser
  - 10x10 test grid renders in correct isometric projection
  - Scroll wheel zoom works (0.5x–2x)
  - Click-drag pan works
  - Tiles don't overlap incorrectly (depth sorting)
- **description:** Build the core PixiJS isometric engine. `IsometricWorld`: initialize PixiJS Application (background #1A1A2E night), conversion functions `screenToIso(x,y)` and `isoToScreen(col,row)` for 64x32 tiles (standard 2:1), world container for transforms, `addToWorld(displayObject, col, row)`, depth sorting by `(col + row)`. `Camera`: `zoom(scale)` clamp 0.5–2.0, `pan(dx,dy)`, `focusOn(col,row,duration)` with ease-out, mouse wheel and click-drag handlers. Integrate into App.tsx with a test grid.

---

### T08 — Tilemap renderer with office layout

- **severity:** high
- **priority:** 8
- **tags:** `frontend`, `engine`
- **dependsOn:** [T07]
- **affectedPaths:** `packages/client/src/engine/TilemapRenderer.ts`, `public/assets/tiles/`
- **acceptanceCriteria:**
  - Full office renders with 6 distinct room areas + hallways
  - Rooms are visually distinguishable
  - Room labels visible
  - Camera zoom/pan work on the full map
- **description:** Render the office tilemap. Create placeholder tile assets: `floor.png` (64x32 beige #F5E6D3), `wall-left.png`, `wall-right.png`, `floor-dark.png` (night variant). `TilemapRenderer`: load textures, define office map ~30x20 tiles with room regions (spec section 5 layout): Lobby (bottom-left), Cafeteria (bottom-right), Desks (middle-left), Deploy (middle-right), Planning (top-left), Council (top-right), hallways connecting them. Each cell: `{ type, room, walkable }`. `getRoomBounds(roomId)` returns bounds + entry point. PixiJS Text labels above each room.

---

### T09 — Sprite manager and character animations

- **severity:** high
- **priority:** 8
- **tags:** `frontend`, `engine`, `characters`
- **dependsOn:** [T07]
- **affectedPaths:** `packages/client/src/engine/SpriteManager.ts`, `packages/client/src/characters/`, `public/assets/sprites/`
- **acceptanceCriteria:**
  - Characters render as animated sprites on the isometric world
  - Walk animation plays with bouncy effect
  - Characters correctly move to target positions
  - Direction changes based on movement vector
  - Multiple characters depth-sort correctly
- **description:** Sprite loading system and character animation state machine. Create placeholder spritesheets (48x48, 4 directions, basic states). `SpriteManager`: load via PixiJS Assets, `createCharacterSprite(role)`, `getAnimation(role, state, direction)`, sprite pool. `animations.ts`: per-state configs (idle 2f loop, walk 4f loop with bounce ±2px, sit 2f, work 3f loop, talk 2f loop, sleep 2f loop, celebrate 3f). `Character.ts`: agentId, position, targetPosition, state machine with `setState()/moveTo()/update(dt)/setDirection()`. `CharacterManager.ts`: `addCharacter()/removeCharacter()/getCharacter()/updateAll()`, desk assignment round-robin (6 desks).

---

### T10 — A* pathfinding with room-to-room waypoints

- **severity:** medium
- **priority:** 7
- **tags:** `frontend`, `engine`
- **dependsOn:** [T08, T09]
- **affectedPaths:** `packages/client/src/engine/Pathfinding.ts`
- **acceptanceCriteria:**
  - Characters navigate between rooms via hallways (not through walls)
  - Path is visually smooth (character changes direction at waypoints)
- **description:** A* on isometric grid using tilemap walkability data. `findPath(from, to)` returns array of {col, row}. Heuristic: Manhattan distance. Neighbors: 4-directional (no diagonal). Waypoint system: `getPathBetweenRooms(fromRoom, toRoom)` returns predefined path via hallways (room exit → hallway → destination room entry → interior position). Pre-compute common room-to-room paths at startup. Integrate with `Character.moveTo()` — character follows path nodes sequentially.

---

### T11 — Particle system

- **severity:** medium
- **priority:** 7
- **tags:** `frontend`, `engine`, `effects`
- **dependsOn:** [T07]
- **affectedPaths:** `packages/client/src/engine/ParticleSystem.ts`, `public/assets/effects/`
- **acceptanceCriteria:**
  - Each particle type is visually distinct
  - Particles animate smoothly (float, fade, fall)
  - Particles auto-cleanup after lifetime expires
- **description:** Predefined particle emitters for cute visual effects (spec section 10). Assets: star 8x8, heart 8x8 pink, sparkle 6x6 white, confetti 4x8 (red/blue/yellow), zzz 12x8. `ParticleSystem`: `emitAt(type, col, row)` with types: sparkle (5-8, float up, fade 1s), confetti (20-30, burst+fall, 2s), hearts (3-5, float slowly, 1.5s), zzz (single Z, float up-right, loop, attached), storm-cloud (dark puff, for blocked state), alert (exclamation mark, for task received in cafeteria). Each particle: PixiJS Sprite with velocity, gravity, alpha fade, rotation. `update(dt)` advances and cleans up expired ones.

---

### T12 — Zustand stores

- **severity:** medium
- **priority:** 7
- **tags:** `frontend`, `state`
- **dependsOn:** [T02]
- **affectedPaths:** `packages/client/src/store/`
- **acceptanceCriteria:**
  - Stores compile and export correctly
  - Office status transitions follow spec section 4 rules
  - Event log caps at 100 entries (FIFO)
- **description:** Create Zustand stores for app state. `worldStore`: officeStatus (closed/opening/active/closing), ticketsByStatus, totalResolved, activeWave. Office status transition logic (spec section 4). `agentStore`: agents Map<agentId, {name, role, model, currentRoom, ticketId, ticketTitle, deskIndex}>. Actions: addAgent, removeAgent, moveAgent, assignTicket, unassignTicket. `uiStore`: selectedAgentId, isPanelOpen, eventLog (max 100 FIFO), isReconnecting. Actions: selectAgent, clearSelection, addEvent, setReconnecting.

---

### T13 — SSE client and event mapper

- **severity:** high
- **priority:** 8
- **tags:** `frontend`, `events`, `integration`
- **dependsOn:** [T06, T12]
- **affectedPaths:** `packages/client/src/events/`
- **acceptanceCriteria:**
  - Client connects to SSE on app mount
  - Events update Zustand stores in real time
  - Reconnection works with exponential backoff
  - Initial state hydration populates all stores correctly
- **description:** Connect frontend to backend SSE stream. `sseClient.ts`: create EventSource, parse JSON events, reconnect with exponential backoff (1s, 2s, 4s, 8s, max 30s, spec section 12). On disconnect: uiStore.setReconnecting(true). On reconnect: fetch GET /state → re-hydrate stores. `eventMapper.ts`: switch on 18 event types → call appropriate store actions (agent:entered→addAgent, ticket:moved→updateTicketStats+moveAgent, verdict:submitted→logEvent, etc.). Each handler also calls uiStore.addEvent() with human-readable summary. `hydrateFromState(InitialState)`: set officeStatus, addAgent for each agent with correct currentRoom, stats, council reviews.

---

### T14 — Implement all 6 office rooms

- **severity:** high
- **priority:** 8
- **tags:** `frontend`, `rooms`
- **dependsOn:** [T08, T09, T10, T11]
- **affectedPaths:** `packages/client/src/rooms/`
- **acceptanceCriteria:**
  - All 6 rooms render with furniture
  - Room-specific animations work (post-its, verdicts, rocket)
  - Lights toggle on/off with office lifecycle
  - Characters can enter/leave rooms correctly
- **description:** Implement room behavior and furniture (spec section 5). `RoomBase`: roomId, bounds, entryPoint, interactiveSpots, getAvailableSpot(), onCharacterEnter/Leave, setLightState(on/off). `Lobby`: door with open/close animation, reception desk, status board with counters. `Desks`: 6 desks with PC (monitor on/off, green "code" flicker), chair, coffee cup. Round-robin desk assignment. `Planning`: kanban board with 3 columns, post-its per ticket (color by severity: pink=critical, orange=high, yellow=medium, green=low). Animations: bounce on create, slide on move, fly-out on transition to in_progress. `Council`: round table, 5 chairs with specialization badges (lock, lightning, building, magnifier, scissors), wall screen. showVerdict → thumbs up/down, celebrate → confetti. `Deploy`: conveyor belt (scrolling texture), rocket, "Completed" counter. addPackage → box on belt, launchRocket → rocket ascends with sparkle trail. `Cafeteria`: tables, coffee machine, donuts. idle→zzZ after 30s, chat bubbles.

---

### T15 — Office lifecycle manager

- **severity:** medium
- **priority:** 7
- **tags:** `frontend`, `integration`
- **dependsOn:** [T13, T14]
- **affectedPaths:** `packages/client/src/engine/IsometricWorld.ts`, `packages/client/src/store/worldStore.ts`
- **acceptanceCriteria:**
  - Office starts dark when no agents/tickets exist
  - Lights animate on sequentially when first agent arrives
  - Lights animate off when last agent leaves
  - Background color transitions smoothly
- **description:** Connect office lifecycle (spec section 4) to the visual world. `computeOfficeStatus(agents, tickets)` determines status based on active sessions + active tickets. In `IsometricWorld`: `transitionToOpening()` animates lights room by room (lobby→planning→desks→council→deploy→cafeteria, 500ms per room), transitions background from night (#1A1A2E) to warm day color. `transitionToClosing()` reverses the sequence. `transitionToClosed()` all dark. `transitionToActive()` all lit. Subscribe worldStore to trigger transitions on status change.

---

### T16 — React UI overlay

- **severity:** medium
- **priority:** 7
- **tags:** `frontend`, `ui`
- **dependsOn:** [T12]
- **affectedPaths:** `packages/client/src/ui/`
- **acceptanceCriteria:**
  - UI overlays canvas without blocking canvas interactions
  - Sidebar shows agent list with real-time updates
  - Event log scrolls and caps at 100 entries
  - Camera controls affect the isometric world
  - Styling matches spec pastel/cute aesthetic
- **description:** React components over the PixiJS canvas (spec section 3.3). Set up Tailwind with spec section 10 colors. `OfficeBadge` (top-left): office status with colored dot, ticket counters by status. `Sidebar` (right, collapsible): active agents list with avatar (colored circle by role), name, role badge, current room, ticket title. Click → selectAgent. `DetailPanel` (popup): agent name, role, model, current ticket (id, title, status, severity), time in status. Close button. `EventLog` (bottom, collapsible): scrollable list with timestamp, icon, text. Auto-scroll. `CameraControls` (bottom-right): zoom slider, 6 room focus buttons. Layout: absolute positioning with pointer-events none/auto. Pixel art friendly typography, rounded borders, pastel palette.

---

### T17 — Full integration: SSE → visual world

- **severity:** high
- **priority:** 9
- **tags:** `frontend`, `integration`
- **dependsOn:** [T13, T14, T15, T16]
- **affectedPaths:** `packages/client/src/events/eventMapper.ts`, `packages/client/src/App.tsx`
- **acceptanceCriteria:**
  - Characters react to every SSE event type with appropriate movement/animation
  - Room furniture reacts (monitors turn on, post-its move, rocket launches)
  - Particles fire on appropriate events
  - Clicking a character opens detail panel
  - The office feels alive when Monsthera is active
- **description:** Wire SSE events to character movements, room behaviors, and particle effects. Update eventMapper to trigger BOTH store actions AND visual actions: agent:entered → addCharacter at lobby + animate walk to correct room. agent:left → animate walk to lobby + removeCharacter. ticket:moved → character walks to new room based on status (in_progress→desks with assignDesk, in_review→council, ready_for_commit→deploy addPackage, resolved→rocket launch, blocked→storm-cloud particle). verdict:submitted → Council.showVerdict() + sparkles/storm. council:consensus → confetti. patch:proposed → paper-fly from desk. coordination:message → chat bubble. convoy:started → office opening. convoy:completed → sparkles everywhere. Game loop in App.tsx: PixiJS Ticker with CharacterManager.updateAll(), ParticleSystem.update(), depth-sort. Click handler on characters → uiStore.selectAgent(). End-to-end test with real Monsthera DB.

---

### T18 — Easter eggs: cat and magic plant

- **severity:** low
- **priority:** 3
- **tags:** `frontend`, `easter-egg`
- **dependsOn:** [T17]
- **affectedPaths:** `packages/client/src/characters/`, `packages/client/src/rooms/`
- **acceptanceCriteria:**
  - Cat moves toward active rooms
  - Cat sleeps when office is closed
  - Plant grows with resolved tickets (4 states)
  - Plant wilts with >3 blocked tickets
- **description:** Cat NPC: 32x32 chibi sprite, not associated with any agent. Moves toward the room with the most characters. Sleeps in lobby (zzZ particles) when office is closed. Occasionally sits on a random developer's desk. Magic plant in lobby: 4 sprites (seed, sprout, plant, flower). Grows based on totalResolved: 0=seed, 5=sprout, 15=plant, 30=flower. Wilts (brown tint + droopy sprite) if >3 tickets in blocked status simultaneously. Recovers when blocked count drops.

---

### T19 — Final pixel art assets

- **severity:** medium
- **priority:** 5
- **tags:** `frontend`, `art`
- **dependsOn:** [T17]
- **affectedPaths:** `public/assets/`
- **acceptanceCriteria:**
  - All placeholder shapes replaced with pixel art
  - Chibi characters have distinct visual identity per role
  - Aesthetic matches spec section 10 (pastel, cute, rounded)
  - All animations still work with new frames
- **description:** Replace placeholder sprites with cute pixel art. Tiles: beige floor diamond 64x32, walls, hallways. Furniture: desks with PCs, chairs, reception desk, kanban board, round table, conveyor belt, rocket, coffee machine, donuts. Rounded edges, pastel colors, plants with faces, monitors with emojis. Characters: 6 role variants, 4 directions, 7 animation states. Chibi: big heads (~60% body), large expressive eyes (2-3px with highlight), 1px outlines in darker color (not pure black). Particles: star, heart, sparkle, confetti, zzZ. UI: role and model badges. Update SpriteManager to load new spritesheets.

---

### T20 — Polish and QA

- **severity:** medium
- **priority:** 5
- **tags:** `qa`, `polish`
- **dependsOn:** [T17, T18, T19]
- **affectedPaths:** various
- **acceptanceCriteria:**
  - 60fps with 10+ characters on screen
  - Animations feel smooth and cute
  - SSE reconnection works seamlessly
  - Empty and active states both look correct
  - README allows setup in < 5 minutes
- **description:** Final polish pass. Performance: ensure 60fps with 10+ characters, profile render loop, optimize depth sorting (only when characters move), sprite batching. Tune animation timings: walk speed, camera easing, particle lifetimes, transition durations. Test reconnection: kill server → "Reconnecting..." overlay → restart → re-hydrate. Test empty state: DB with no agents or tickets → office closed, dark, cat sleeping. Test active convoy: launch convoy on a real Monsthera project → watch office come alive. README.md: prerequisites, env vars, how to start server and client, link to Monsthera.

---

## Dependency Graph

```
T01 ─┬─ T02 ── T12 ── T16 ─────────────────────────┐
     │                                               │
     ├─ T03 ─┬─ T04 ── T05 ── T06 ── T13 ─┐        │
     │       └──────────────────────────────┤        │
     │                                      │        │
     ├─ T07 ─┬─ T08 ─┐                     │        │
     │       │        ├─ T10 ─┐             │        │
     │       ├─ T09 ─┘        │             │        │
     │       └─ T11 ──────────┴─ T14 ─┐     │        │
     │                                 │     │        │
     │                                 └─ T15 ┴─ T17 ─┤
     │                                           │     │
     │                                           ├─ T18│
     │                                           ├─ T19│
     │                                           └─────┴─ T20
```

## Expected Waves

| Wave | Tickets | Rationale |
|---|---|---|
| 1 | T01 | Scaffold — everything depends on this |
| 2 | T02, T03, T07 | Independent: types, backend DB, frontend engine |
| 3 | T04, T08, T09, T11, T12 | SSE manager, tilemap, sprites, particles, stores |
| 4 | T05, T10, T16 | Poll loop, pathfinding, UI overlay |
| 5 | T06, T14 | REST routes, rooms |
| 6 | T13, T15 | SSE client, office lifecycle |
| 7 | T17 | Full integration |
| 8 | T18, T19 | Easter eggs, pixel art (parallel) |
| 9 | T20 | Final polish |

---

## Agent Instructions

### Step 1: Populate knowledge store

```
store_knowledge(
  type="plan",
  scope="repo",
  title="Monsthera Office Implementation Plan",
  content="Full-stack isometric pixel art office visualization for Monsthera. 20 tickets, 9 waves. See docs/superpowers/plans/2026-03-17-monsthera-office.md and docs/superpowers/plans/2026-03-17-monsthera-office-tickets.md",
  tags=["monsthera-office", "plan", "implementation"]
)
```

### Step 2: Create tickets with `decompose_goal`

Use this document as reference. The `goal` is:

> "Build Monsthera Office: a full-stack web app that visualizes Monsthera multi-agent development activity as an isometric pixel art office with cute chibi characters, 6 themed rooms, real-time SSE connection, and animated interactions."

Pass the 20 tickets as `proposedTasks` with their dependencies as `dependsOn` (0-based indices).

### Step 3: Work group and convoy

```
create_work_group(title="Monsthera Office v1")
add_tickets_to_group(groupId, [all 20 ticket IDs])
compute_waves(groupId)
launch_convoy(groupId)
```
