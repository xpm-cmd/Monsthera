# Agora Office — Design Spec

*Real-time isometric pixel art visualization of Agora agents working in a virtual office with Habbo/chibi cute aesthetics*

---

## 1. Goal

Create a companion web app for Agora that visualizes multi-agent development activity as an animated isometric office with cute pixel art aesthetics. The app reads Agora's SQLite database in read-only mode and translates events (tickets, agents, reviews, coordination) into animated characters interacting in a virtual office.

The project serves as the **perfect demo of Agora**: built from scratch using Agora's full workflow (`decompose_goal` → tickets with dependencies → `compute_waves` → `launch_convoy`), demonstrating that Agora accelerates multi-agent development.

**Project name:** `agora-office`
**Repository:** Separate from Agora (independent companion project)

---

## 2. Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Repo | Separate from Agora | Independent companion project |
| Frontend | React + PixiJS | PixiJS is the standard for 2D isometric graphics; React for UI overlay |
| Backend | Node + Express + better-sqlite3 | Same ecosystem as Agora, direct SQLite reading |
| Communication | SSE (Server-Sent Events) | Real-time push without WebSocket complexity |
| Visual style | Isometric chibi pixel art, cute pastel palette | Maximum visual impact and memorability |
| Data | Live visualization (not replay) | Impressive for demos with Agora running |
| Development order | Visual first, data second | Solid visual foundation before connecting Agora |
| State management | Zustand | Lightweight, ideal for isometric world state + UI |
| Monorepo | pnpm workspaces | `packages/client` + `packages/server` |

---

## 3. Architecture

```
┌─────────────────────────────────────────────────────┐
│  Browser (React + PixiJS)                           │
│                                                     │
│  ┌───────────────────┐  ┌────────────────────────┐  │
│  │ Isometric World   │  │ UI Overlay (React)     │  │
│  │ (PixiJS Canvas)   │  │                        │  │
│  │                   │  │ - Agent sidebar        │  │
│  │ - Tilemap engine  │  │ - Ticket detail panel  │  │
│  │ - Sprite system   │  │ - Event log feed       │  │
│  │ - Pathfinding     │  │ - Camera controls      │  │
│  │ - Particles       │  │ - Office status badge  │  │
│  │ - Camera          │  │                        │  │
│  └────────┬──────────┘  └───────────┬────────────┘  │
│           └───────┬─────────────────┘               │
│                   │                                 │
│           ┌───────┴──────────┐                      │
│           │  Zustand Store   │                      │
│           │  (world state)   │                      │
│           └───────┬──────────┘                      │
│                   │ SSE EventSource                 │
└───────────────────┼─────────────────────────────────┘
                    │
┌───────────────────┼─────────────────────────────────┐
│  Backend (Node + Express)          port 3001        │
│                                                     │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ REST API     │  │ SSE Stream │  │ DB Poller   │  │
│  │ GET /state   │  │ GET /events│  │ (1-2s loop) │  │
│  │ GET /rooms   │  │            │  │ diff engine │  │
│  └──────────────┘  └────────────┘  └──────┬──────┘  │
│                                           │         │
└───────────────────────────────────────────┼─────────┘
                                            │
                                  ┌─────────┴─────────┐
                                  │  Agora SQLite DB   │
                                  │  (external, r/o)   │
                                  │                    │
                                  │  Path configured   │
                                  │  via AGORA_DB_PATH │
                                  └───────────────────┘
```

### 3.1 Backend — Components

**REST API**
- `GET /state` — Full current state for initial hydration (see section 8)
- `GET /rooms` — Static room metadata (positions, capacity)
- `GET /health` — Simple healthcheck

**SSE Stream**
- `GET /events` — Typed event stream (see section 7)
- The client connects on app mount and reconnects with exponential backoff if the connection is lost

**DB Poller (diff engine)**
- Loop every 1-2 seconds reading Agora tables
- Compares against previous in-memory state
- Emits SSE events only when there are changes
- Change detection strategy detailed in section 6

### 3.2 Frontend — Isometric World (PixiJS)

**Tilemap engine**
- Isometric grid with base tiles (floor, walls, decoration)
- Tile size: 64x32px (standard isometric 2:1)
- Rooms defined as tilemap regions with metadata (name, type, capacity)
- Furniture and objects as sprites positioned on tiles

**Sprite system**
- Chibi characters 48x48px with spritesheet per direction (N, S, E, W) and state
- Animation states: `idle`, `walk`, `sit`, `work`, `talk`, `sleep`, `celebrate`
- Each character has: base sprite + color overlay (to differentiate agents) + role badge

**Pathfinding**
- A* on isometric grid with tiles marked as walkable/blocked
- Predefined waypoints between rooms (lobby door → hallway → destination room door → position in room)
- Movement queue: if a character receives a new destination while walking, it finishes the current segment and redirects

**Particle system**
- Predefined emitters: stars, hearts, sparkles, confetti, zzZ, thought bubbles
- Linked to events (approval = confetti, long idle = zzZ, new ticket = sparkle)

**Camera system**
- Zoom in/out with scroll wheel (range: 0.5x to 2x)
- Pan with click-drag or arrow keys
- Click on character or room centers the camera with smooth animation

### 3.3 Frontend — UI Overlay (React)

React layer mounted over the PixiJS canvas:

- **Agent sidebar** — List of active agents with avatar, name, role, current state, assigned ticket
- **Detail panel** — On character click: popup with ticket info, time in status, proposed patches
- **Event log** — Scrollable feed of recent events with timestamp and icon
- **Office status badge** — Top corner: office status (closed/opening/active/closing), ticket counters by status
- **Camera controls** — Zoom slider, room focus buttons

---

## 4. Office Lifecycle

The office reacts to Agora's global activity level. State is computed based on active sessions and non-finished tickets.

| State | Condition | Visual |
|---|---|---|
| **Closed** | 0 active sessions AND 0 tickets in (backlog..ready_for_commit) | Lights off, dark/night palette, stars in windows, cat sleeping at reception |
| **Opening** | First active session OR first ticket created (transitioning from closed) | Lights turn on room by room with sequential animation (lobby → planning → desks → council → deploy → cafeteria). Duration: ~3 seconds |
| **Active** | >= 1 active session OR >= 1 active ticket | Lights on, warm lighting, characters at their stations, subtle ambient particles |
| **Closing** | Last session ends AND 0 active tickets (transitioning from active) | Agents walk to lobby and exit one by one. Rooms go dark as they empty. Duration: ~5 seconds |

**Transitions:**
- Closed → Opening: triggered when `sessions` has at least 1 `state=active` or `tickets` has at least 1 in active status
- Opening → Active: when the lights animation finishes
- Active → Closing: when the last agent leaves and there are no pending tickets
- Closing → Closed: when the closing animation finishes

---

## 5. Rooms — Office Zones

### General Layout (relative positioning)

```
┌─────────────────────────────────────────────────┐
│                                                 │
│   ┌──────────┐              ┌──────────────┐    │
│   │ PLANNING │              │   COUNCIL    │    │
│   │ (planning│              │   (meeting   │    │
│   │  room)   │              │    room)     │    │
│   └────┬─────┘              └──────┬───────┘    │
│        │         HALLWAY           │            │
│   ─────┴───────────────────────────┴─────────   │
│        │                           │            │
│   ┌────┴──────────────────┐  ┌─────┴────────┐   │
│   │     DESKS             │  │   DEPLOY     │   │
│   │  (developer area)     │  │   (deploy    │   │
│   │                       │  │    zone)     │   │
│   └───────────────────────┘  └──────────────┘   │
│        │                           │            │
│   ─────┴───────────────────────────┴─────────   │
│        │         HALLWAY           │            │
│   ┌────┴─────┐              ┌──────┴────────┐   │
│   │  LOBBY   │              │  CAFETERIA    │   │
│   │(entrance)│              │              │   │
│   │   🚪     │              │  ☕ 🍩        │   │
│   └──────────┘              └───────────────┘   │
│                                                 │
└─────────────────────────────────────────────────┘
```

The exact tile layout is defined during implementation. This diagram establishes the topology (which rooms are adjacent and how they connect via hallways).

### 5.1 Lobby / Reception

**Purpose:** Agent entry and exit point.

**Visual elements:**
- Main door with open/close animation
- Reception desk with status board (LED board pixel art showing ticket counters)
- Decorative plant with smiley face
- Welcome mat

**Behavior:**
- When a new `session` appears with `state=active`: a character materializes at the door and walks in
- The character pauses briefly at the desk (1-2s) then walks to their destination room based on role/activity
- When `session.state` changes to `ended`: the character walks from their current room → lobby → exits through the door and disappears

**Agora data:**
- `agents` — Character identity (name, role, model)
- `sessions` — Lifecycle (active/ended determines entry/exit)

### 5.2 Developer Desks

**Purpose:** Where developers work on tickets.

**Visual elements:**
- 6 desks with pixel art PCs, chair, coffee mug
- Each desk has a mini-monitor showing animated "code" when occupied
- Floating bubble above character with ticket title (truncated to ~30 chars)
- Empty desks have monitors turned off

**Behavior:**
- An agent walks here when they have an assigned ticket in status `in_progress`
- Sits down (bouncy animation) and starts "working" (typing animation)
- Monitor flickers with green text on dark background (simulating code)
- When proposing a patch (new `patches` row): "deliver document" animation — paper floats out from the desk
- Stands up when the ticket leaves `in_progress`

**Desk assignment:**
- Round-robin by arrival order
- If all 6 desks are occupied: new agents stand beside the area (never rejected, just look "crowded")
- When an agent leaves, their desk becomes available for the next one

**Agora data:**
- `tickets` where `status = 'in_progress'` and `assignee_agent_id` matches
- `job_slots` where `status = 'active'` and `role = 'developer'`
- `patches` for delivery animation

### 5.3 Planning Room

**Purpose:** Visualize the backlog and work organization.

**Visual elements:**
- Large kanban-style whiteboard with 3 columns: Backlog | Analysis | Approved
- Colored post-its (one per ticket) with mini title text
- Post-it color by severity: pink = critical, orange = high, yellow = medium, green = low
- The planner stands in front of the whiteboard

**Behavior:**
- New tickets appear as post-its with bounce animation in the Backlog column
- When a ticket changes status (`backlog` → `technical_analysis` → `approved`), the post-it slides to the corresponding column
- When a ticket moves to `in_progress`, the post-it "flies away" from the whiteboard toward the desks area
- The planner occasionally "moves" post-its (arm pointing animation)

**Agora data:**
- `tickets` with `status IN ('backlog', 'technical_analysis', 'approved')`
- `ticket_dependencies` — dotted lines between related post-its (v1: optional, can be omitted if complex)

### 5.4 Council Room (Meeting Room)

**Purpose:** Visualize the multi-perspective code review process.

**Visual elements:**
- Round table with 5 chairs
- Each chair has a specialization badge:
  - 🔒 Security (lock)
  - ⚡ Performance (lightning)
  - 🏗️ Architect (building)
  - 🔍 Patterns (magnifier)
  - ✂️ Simplifier (scissors)
- Screen/projector on the wall showing the ticket in review
- Whiteboard for notes

**Behavior:**
- When a ticket moves to `in_review`: the screen turns on showing the ticket title
- Assigned reviewers (`council_assignments`) walk from their current position to the meeting room
- They sit in their specialization's chair
- When submitting a verdict (`review_verdicts`):
  - `approve` → Green thumbs up with sparkles above their head
  - `veto` → Red thumbs down with storm cloud
  - `conditional_approve` → Yellow thumbs up
- When consensus is reached (`check_consensus` returns `advisoryReady`): confetti explodes over the table, everyone celebrates (`celebrate` animation)
- After the celebration, reviewers stand up and return to their previous position

**Agora data:**
- `tickets` where `status = 'in_review'`
- `council_assignments` — who is assigned and with which specialization
- `review_verdicts` — individual verdicts

### 5.5 Deploy Zone

**Purpose:** Visualize completed and resolved tickets.

**Visual elements:**
- Animated conveyor belt (continuous loop of pixel art texture)
- Launch pad with mini rocket
- "Completed" screen with counter
- Boxes/packages on the belt representing tickets

**Behavior:**
- Tickets in `ready_for_commit`: appear as a package at the start of the belt
- The package travels slowly along the belt (3-5s animation)
- On transition to `resolved`: the package reaches the end → the rocket launches with sparkle animation and particle trail
- "Completed" counter increments with pulse effect
- On transition to `closed`: the package simply disappears with fade out at the end of the belt

**Agora data:**
- `tickets` where `status IN ('ready_for_commit', 'resolved', 'closed')`
- `patches` where `state = 'committed'`

### 5.6 Cafeteria

**Purpose:** Social zone for idle agents and inter-agent communication.

**Visual elements:**
- Table with chairs, coffee machine, shelf with pixel art donuts
- Potted plant with smiley face
- Window with exterior view (stars at night, sun during day based on real system time)

**Behavior:**
- Agents with no assigned ticket and an active session go here automatically
- They sit, drink coffee (animation), produce zzZ if idle for >30s
- Coordination messages (`coordination_messages`) appear as speech bubbles between present characters
- If an agent receives a ticket while in the cafeteria, they stand up with "alert" animation (!) and walk to their destination

**Agora data:**
- `coordination_messages` — chat bubbles
- Agents with active session and no ticket assigned in `in_progress`

---

## 6. Change Detection System (DB Poller)

### Primary source: `dashboard_events`

Agora **already records events** in the `dashboard_events` table for every relevant action. Instead of polling+diffing 13 tables, the Agora Office backend primarily uses this table with an incremental cursor:

```sql
SELECT * FROM dashboard_events WHERE id > :lastSeenId ORDER BY id LIMIT 100
```

**Event types that Agora already emits:**

**Events Agora currently emits (confirmed in code):**

| Agora Event | Current fields in `data_json` | Visual mapping |
|---|---|---|
| `ticket_created` | `ticketId`, `status`, `severity`, `creatorAgentId` | New post-it on whiteboard |
| `ticket_status_changed` | `ticketId`, `previousStatus`, `status` | Character moves between rooms |
| `ticket_assigned` | `ticketId`, `agentId` | Agent walks to desk |
| `ticket_unassigned` | `ticketId`, `agentId` | Agent stands up from desk |
| `ticket_verdict_submitted` | `ticketId`, `agentId`, `specialization`, `verdict` | Thumbs up/down in council |
| `ticket_commented` | `ticketId`, `commentId`, `agentId` | Text bubble |
| `job_slot_claimed` / `job_slot_active` | varies | Agent takes desk position |
| `job_slot_completed` | varies | Agent stands up |
| `convoy_started` | raw event object | Office "activates" |
| `convoy_wave_started` | raw event object | Wave desks light up |
| `convoy_wave_advanced` | raw event object | Visual wave transition |
| `convoy_agent_spawned` | raw event object | New character enters |
| `convoy_agent_finished` | raw event object | Character exits |
| `convoy_completed` | raw event object | General celebration |

**Events Agora does NOT emit yet (require Agora changes, see section 17):**

| Missing event | Required data | Impact |
|---|---|---|
| `agent_registered` | `agentId`, `name`, `role`, `model` | Without this, character entry is not detected via dashboard_events |
| `session_changed` | `sessionId`, `agentId`, `state` | Without this, agent entry/exit is not detected |
| `patch_proposed` | `ticketId`, `agentId`, `proposalId` | Without this, developer code delivery is not detected |
| `council_consensus_reached` | `ticketId`, `result` | Without this, council consensus must be inferred |
| `coordination_message_sent` | `messageId`, `fromAgentId`, `type` | Without this, coordination_messages must be polled directly |

### Complementary polling (required until Agora emits the missing events)

| Table | Change detection | Frequency |
|---|---|---|
| `agents` | Track `MAX(rowid)`, compare with previous snapshot | Every 2s |
| `sessions` | Query `WHERE state='active'`, compare set with previous snapshot | Every 2s |
| `patches` | Track `MAX(id)` for new ones, `updated_at` for state changes | Every 2s |
| `council_assignments` | Track `MAX(id)` | Every 2s |
| `coordination_messages` | Track `MAX(id)` (for chat bubbles) | Every 2s |

**Note:** If the changes from sections 17.1 and 17.2 are implemented in Agora, complementary polling is reduced to just `council_assignments` (which has no dedicated event).

### In-memory snapshot

```typescript
interface PollState {
  // Primary cursor
  lastDashboardEventId: number;

  // Complementary cursors (direct polling)
  lastAgentRowid: number;
  lastPatchId: number;
  lastCouncilAssignmentId: number;
  lastCoordinationMessageId: number;

  // Snapshots for mutable tables
  activeSessions: Map<string, { agentId: string; state: string }>;
  patchStates: Map<string, string>; // proposalId → state

  // Timestamp
  lastPollAt: string;
}
```

### Filtering by `repoId`

The `dashboard_events` table has a `repo_id` column. The backend must filter by the correct repo:

```sql
SELECT * FROM dashboard_events
WHERE repo_id = :repoId AND id > :lastSeenId
ORDER BY id LIMIT 100
```

The `repoId` is obtained by querying the `repos` table at startup (there is usually only 1 repo). If there are multiple repos, it is configured via `AGORA_REPO_ID` env var (see section 11).

---

## 7. SSE Events

All events follow this format:

```typescript
interface SSEEvent {
  type: string;       // event type
  timestamp: string;  // ISO 8601
  data: object;       // type-specific payload
}
```

### Event Catalog

The backend translates raw Agora data into these normalized SSE events. The "Source" column indicates whether it comes from `dashboard_events` (DE) or direct polling (Poll).

| SSE Event | Source | Payload | Visual Action |
|---|---|---|---|
| `agent:entered` | Poll: `sessions`+`agents` | `{ agentId, name, role, model }` | Character appears at lobby door |
| `agent:left` | Poll: `sessions` | `{ agentId }` | Character walks to lobby and exits |
| `ticket:created` | DE: `ticket_created` | `{ ticketId, title, severity, status }` | Post-it on whiteboard with bounce |
| `ticket:moved` | DE: `ticket_status_changed` | `{ ticketId, previousStatus, newStatus, agentId }` | Transition (see table below) |
| `ticket:assigned` | DE: `ticket_assigned` | `{ ticketId, agentId }` | Agent walks to desk |
| `ticket:unassigned` | DE: `ticket_unassigned` | `{ ticketId, agentId }` | Agent stands up, goes to cafeteria |
| `ticket:commented` | DE: `ticket_commented` | `{ ticketId, agentId, contentPreview }` | Text bubble above character |
| `verdict:submitted` | DE: `ticket_verdict_submitted` | `{ ticketId, agentId, specialization, verdict }` | Thumbs up/down in council |
| `council:assigned` | Poll: `council_assignments` | `{ ticketId, agentId, specialization }` | Reviewer walks to meeting room |
| `council:consensus` | DE: `council_consensus_reached` (*) | `{ ticketId, result }` | Confetti in meeting room |
| `patch:proposed` | Poll: `patches` | `{ ticketId, agentId, proposalId }` | Developer "delivers document" |
| `patch:committed` | Poll: `patches` state change | `{ ticketId, proposalId, committedSha }` | Rocket launches in deploy zone |
| `coordination:message` | Poll: `coordination_messages` | `{ fromAgentId, toAgentId, type }` | Chat bubble between characters |
| `wave:advanced` | DE: `convoy_wave_advanced` | `{ groupId, wave }` | Wave desks light up |
| `job:claimed` | DE: `job_slot_claimed` | `{ slotId, agentId, role, ticketId }` | Agent walks to station |
| `job:completed` | DE: `job_slot_completed` | `{ slotId, agentId }` | Agent stands up |
| `convoy:started` | DE: `convoy_started` | `{ groupId }` | Office activates |
| `convoy:completed` | DE: `convoy_completed` | `{ groupId }` | General celebration |

(*) Requires Agora change — see section 17.2.

**Note on missing fields in Agora:** Some DE events don't include all the fields needed for the SSE payload (e.g., `ticket_created` doesn't include `title`, `ticket_commented` doesn't include `contentPreview`). The backend performs an additional JOIN/query to complete these fields. Section 17.1 proposes enriching these events in Agora to eliminate the extra queries.

### Ticket transitions → animations

| Transition | Animation |
|---|---|
| `backlog` → `technical_analysis` | Post-it slides to "Analysis" column on whiteboard |
| `technical_analysis` → `approved` | Post-it slides to "Approved" column, sparkle |
| `approved` → `in_progress` | Post-it "flies away" from whiteboard, assigned agent walks to desk |
| `in_progress` → `in_review` | Agent stands up, paper flies out to council room, screen turns on |
| `in_review` → `ready_for_commit` | Confetti in council, package appears on deploy belt |
| `ready_for_commit` → `resolved` | Package reaches end of belt, rocket launches |
| any → `blocked` | Character looks worried, storm cloud above their head, freezes |
| `blocked` → (any other) | Cloud disappears, character resumes normal animation |

---

## 8. Initial Hydration (`GET /state`)

When the browser connects (or reconnects), it needs the full current state to render the office correctly.

```typescript
interface InitialState {
  office: {
    status: 'closed' | 'opening' | 'active' | 'closing';
  };

  agents: Array<{
    agentId: string;
    name: string;
    role: string;
    model: string;
    hasActiveSession: boolean;
    // Calculated position: which room the agent should be in based on their current activity
    currentRoom: 'lobby' | 'desks' | 'planning' | 'council' | 'deploy' | 'cafeteria' | null;
    currentTicketId: string | null;
    currentTicketTitle: string | null;
    deskIndex: number | null;       // if at desks, which desk
  }>;

  tickets: Array<{
    ticketId: string;
    title: string;
    status: string;
    severity: string;
    assigneeAgentId: string | null;
  }>;

  // Multiple tickets can be in review simultaneously (different waves/work groups)
  councilReviews: Array<{
    ticketId: string;
    ticketTitle: string;
    assignments: Array<{
      agentId: string;
      specialization: string;
    }>;
    verdicts: Array<{
      agentId: string;
      verdict: string;
    }>;
  }>;

  waves: {
    activeGroupId: string | null;
    currentWave: number | null;
  };

  stats: {
    totalTickets: number;
    byStatus: Record<string, number>;
    totalResolved: number;
  };
}
```

**`currentRoom` logic:** The backend calculates which room each active agent should be in:
1. If they have an assigned `in_progress` ticket → `desks`
2. If they are assigned to the council of an `in_review` ticket → `council`
3. If their role is `planner` or `facilitator` → `planning`
4. If they have an active session but none of the above → `cafeteria`
5. If they have no active session → `null` (not rendered)

---

## 9. Characters — Agent Visual Identity

### Agent ↔ Character Relationship

- **1 character per agent** (not per session). If an agent has multiple sessions, it's still 1 character.
- Character identity comes from the `agents` table (name, role, model).
- The visual lifecycle (enters/exits the office) is driven by `sessions`: enters when they have at least 1 active session, exits when all their sessions are `ended`.

### Sprite Assignment

Each agent receives a unique sprite based on their role:

| Role | Base sprite | Color accent |
|---|---|---|
| `developer` | Character with laptop/headphones | Sky blue |
| `reviewer` | Character with magnifier/clipboard | Lavender |
| `facilitator` | Character with megaphone/whiteboard | Mint |
| `planner` | Character with planner/post-its | Cream yellow |
| `observer` | Character with binoculars | Light gray |
| `admin` | Character with crown/badge | Pink |

The agent's **model** (claude-opus, claude-sonnet, etc.) is shown as a badge/insignia on the corner of the character, not as a different sprite.

### Spritesheet Structure

Each character has a spritesheet with:
- 4 directions: N, S, E, W (isometric: NE, SE, SW, NW)
- Frames per state: idle (2 frames), walk (4 frames), sit (2 frames), work (3 frames), talk (2 frames), sleep (2 frames), celebrate (3 frames)
- Total per character: ~4 dirs x ~18 frames = ~72 frames
- Size per frame: 48x48 px

---

## 10. Visual Identity

### Color Palette

| Use | Color | Hex (reference) |
|---|---|---|
| Floor tiles | Light beige | `#F5E6D3` |
| Walls | Cream | `#FFF8E7` |
| Furniture | Pastel wood | `#D4A574` |
| Accent 1 | Soft pink | `#FFB5C2` |
| Accent 2 | Lavender | `#C5B3E6` |
| Accent 3 | Mint | `#B8E6CF` |
| Accent 4 | Cream yellow | `#FFE5A0` |
| Accent 5 | Sky blue | `#A8D8EA` |
| UI text | Warm dark gray | `#5A4A3A` |
| Night/closed | Dark blue | `#1A1A2E` |

### Sprite Style

- **Chibi:** Large heads (~60% of body), small bodies
- **Eyes:** Large, expressive, 2-3 px, with highlight
- **Outlines:** 1px, darker color than fill (not pure black)
- **Shadows:** Soft, 1-2 shades darker, no hard edges
- **Furniture:** Rounded edges, no sharp corners
- **Plants:** All have faces (eyes + smile)
- **Monitors:** Show emojis or animated "code"

### Animations

- **Walk:** Bouncy — character rises 1-2px on each step
- **Sit:** Overshoot — drops slightly too far and bounces when sitting
- **Celebrate:** Jumps with arms up, hearts/stars come out
- **Sleep:** Head gradually lowers, zzZ appear and float
- **Work:** Hands move over keyboard, "code" lines appear on monitor
- **Talk:** Mouth opens/closes (2 frames), text bubble appears

### Easter Eggs

- **Office cat** — NPC that moves toward the room with the most agents. Sleeps at reception when the office is closed. Occasionally sits on a random developer's desk.
- **Magic plant** — Grows as tickets are resolved (4 states: seed, sprout, plant, flower). Wilts if >3 tickets are blocked simultaneously.

---

## 11. Configuration

### Backend Environment Variables

| Variable | Required | Description | Example |
|---|---|---|---|
| `AGORA_DB_PATH` | Yes | Absolute path to Agora's SQLite | `/Users/xpm/Projects/Github/Agora/.agora/agora.db` |
| `PORT` | No | Server port (default: 3001) | `3001` |
| `POLL_INTERVAL_MS` | No | Polling interval in ms (default: 1500) | `1500` |
| `CORS_ORIGIN` | No | Allowed CORS origin (default: `http://localhost:5173`) | `http://localhost:5173` |
| `AGORA_REPO_ID` | No | Numeric repo ID in Agora's DB (default: auto-detect first repo) | `1` |

### Startup Validation

The backend must verify on startup:
1. `AGORA_DB_PATH` is defined and the file exists
2. The file is a valid SQLite and can be opened in read-only mode
3. Expected tables exist (at least: `agents`, `sessions`, `tickets`, `ticket_history`)
4. If any verification fails: clear log with instructions on how to configure, exit with code 1

---

## 12. Error Handling

| Scenario | Behavior |
|---|---|
| SQLite file not found | Backend: error log with attempted path + instructions. Exit 1. |
| SQLite locked/busy | Backend: retry with backoff (100ms, 200ms, 400ms). If it fails 3 times in a row: log warning, skip poll cycle, retry in the next interval. |
| SSE connection lost | Frontend: semi-transparent "Reconnecting..." overlay with spinner. Exponential backoff (1s, 2s, 4s, 8s, max 30s). On reconnect: fetch `GET /state` to re-hydrate. |
| Schema incompatible | Backend: log warning with missing tables. Operate in degraded mode (ignore non-existent tables, emit events only from available ones). |
| Agent without active session | Frontend: don't render character. If it was rendered, exit animation. |

---

## 13. Detailed Tech Stack

| Layer | Technology | Minimum Version |
|---|---|---|
| Runtime | Node.js | 20+ |
| Package manager | pnpm | 8+ |
| Frontend framework | React | 18+ |
| Build tool | Vite | 5+ |
| 2D Graphics | PixiJS | 8+ |
| State management | Zustand | 4+ |
| UI styling | Tailwind CSS | 3+ |
| Backend framework | Express | 4+ |
| DB access | better-sqlite3 | 11+ |
| TypeScript | TypeScript | 5+ |
| Linter | ESLint + Prettier | — |

### Monorepo Structure

```
agora-office/
├── package.json              # workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json        # shared TS config
├── packages/
│   ├── client/               # React + PixiJS app
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   ├── vite.config.ts
│   │   ├── index.html
│   │   ├── public/
│   │   │   └── assets/       # sprites, tilemaps, fonts
│   │   │       ├── sprites/  # character spritesheets
│   │   │       ├── tiles/    # floor, wall, furniture tiles
│   │   │       ├── effects/  # particles, sparkles
│   │   │       └── ui/       # icons, badges
│   │   └── src/
│   │       ├── main.tsx
│   │       ├── App.tsx
│   │       ├── engine/       # PixiJS isometric engine
│   │       │   ├── IsometricWorld.ts
│   │       │   ├── TilemapRenderer.ts
│   │       │   ├── SpriteManager.ts
│   │       │   ├── Pathfinding.ts
│   │       │   ├── ParticleSystem.ts
│   │       │   └── Camera.ts
│   │       ├── characters/   # character logic
│   │       │   ├── Character.ts
│   │       │   ├── CharacterManager.ts
│   │       │   └── animations.ts
│   │       ├── rooms/        # room definitions
│   │       │   ├── Lobby.ts
│   │       │   ├── Desks.ts
│   │       │   ├── Planning.ts
│   │       │   ├── Council.ts
│   │       │   ├── Deploy.ts
│   │       │   └── Cafeteria.ts
│   │       ├── store/        # Zustand stores
│   │       │   ├── worldStore.ts
│   │       │   ├── agentStore.ts
│   │       │   └── uiStore.ts
│   │       ├── events/       # SSE client + event handlers
│   │       │   ├── sseClient.ts
│   │       │   └── eventMapper.ts
│   │       └── ui/           # React overlay components
│   │           ├── Sidebar.tsx
│   │           ├── DetailPanel.tsx
│   │           ├── EventLog.tsx
│   │           ├── OfficeBadge.tsx
│   │           └── CameraControls.tsx
│   │
│   ├── server/               # Node + Express backend
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts
│   │       ├── config.ts       # env vars, validation
│   │       ├── db/
│   │       │   ├── reader.ts   # SQLite read-only access
│   │       │   └── queries.ts  # typed queries per table
│   │       ├── poller/
│   │       │   ├── pollLoop.ts # main poll loop
│   │       │   ├── differ.ts   # state diff engine
│   │       │   └── state.ts    # PollState type + snapshot
│   │       ├── sse/
│   │       │   ├── stream.ts   # SSE connection manager
│   │       │   └── events.ts   # event type definitions
│   │       └── routes/
│   │           ├── state.ts    # GET /state
│   │           ├── rooms.ts    # GET /rooms
│   │           └── health.ts   # GET /health
│   │
│   └── shared/               # shared types
│       ├── package.json
│       ├── tsconfig.json
│       └── src/
│           ├── events.ts     # SSE event type definitions
│           ├── state.ts      # InitialState type
│           └── rooms.ts      # room metadata types
```

---

## 14. Development Flow with Agora

This project is built using Agora to demonstrate its own value. The flow is:

### Step 1: Initialize repo and Agora
```bash
mkdir agora-office && cd agora-office
git init
agora init && agora index --semantic
```

### Step 2: Create tickets with `decompose_goal`
Use Agora's `decompose_goal` tool passing this spec as context. The goal decomposes into atomic tickets with dependencies. Expected structure example:

```
Ticket 1: "Scaffold monorepo with pnpm workspaces"
  → no dependencies
Ticket 2: "Implement isometric tilemap engine"
  → depends on: 1
Ticket 3: "Create sprite system with animations"
  → depends on: 1
Ticket 4: "Implement Express backend with SQLite reader"
  → depends on: 1
Ticket 5: "Create A* pathfinding on isometric grid"
  → depends on: 2
...
```

Tickets are created with:
- `title` — Concrete action
- `description` — What to implement, referencing sections of this spec
- `affectedPaths` — Files/directories to touch
- `tags` — For categorization (frontend, backend, engine, ui, etc.)
- `severity` — medium for most, high for core engine
- `acceptanceCriteria` — What needs to happen to consider the ticket done

### Step 3: Group and compute waves
```
create_work_group → groups all tickets
compute_waves    → automatically calculates waves based on dependencies
```

### Step 4: Launch convoy
```
launch_convoy → executes wave by wave, spawning agents
```

Each wave executes parallelizable tickets. Agents pick tickets, implement, propose patches, go through council review.

### Step 5: Observe
While the convoy runs, Agora Office itself (once functional) would show the agents working on it. Until then, progress can be observed with `list_tickets`, `get_wave_status`, etc.

---

## 15. Out of Scope (v1)

- Replay/recording of past sessions
- Sound/music
- Room editor or layout customization
- Authentication
- Multiple simultaneous Agora instances
- Mobile responsive
- Ticket dependency visualization (lines on whiteboard)
- Alternative themes or skins
- Visual state persistence (character positions are recalculated on reload)

---

## 16. Agora Schema — Reference

Tables the app consumes (all read-only):

```sql
-- Agent identity
agents (id, name, type, provider, model, model_family, model_version,
        identity_source, role_id, trust_tier, registered_at)

-- Active/terminated sessions
sessions (id, agent_id, state, connected_at, last_activity,
          claimed_files_json, worktree_path, worktree_branch)

-- Work tickets
tickets (id, repo_id, ticket_id, title, description, status, severity,
         priority, tags_json, affected_paths_json, acceptance_criteria,
         creator_agent_id, assignee_agent_id, resolved_by_agent_id,
         commit_sha, resolution_commits_json, required_roles_json,
         created_at, updated_at)

-- Transition history
ticket_history (id, ticket_id, from_status, to_status, agent_id,
                session_id, comment, timestamp)

-- Ticket comments
ticket_comments (id, ticket_id, agent_id, session_id, content, created_at)

-- Council verdicts
review_verdicts (id, ticket_id, agent_id, session_id, specialization,
                 verdict, reasoning, created_at, superseded_by)

-- Council assignments
council_assignments (id, ticket_id, agent_id, specialization,
                     assigned_by_agent_id, assigned_at)

-- Ticket dependencies
ticket_dependencies (id, from_ticket_id, to_ticket_id, relation_type,
                     created_by_agent_id, created_at)

-- Coordination messages
coordination_messages (id, repo_id, message_id, from_agent_id, to_agent_id,
                       type, payload_json, timestamp)

-- Proposed patches
patches (id, repo_id, proposal_id, base_commit, bundle_id, state, diff,
         message, touched_paths_json, agent_id, session_id, committed_sha,
         ticket_id, created_at, updated_at)

-- Dashboard events (already emitted by Agora)
dashboard_events (id, repo_id, event_type, data_json, timestamp)

-- Job slots (convoy/loops)
job_slots (id, repo_id, slot_id, loop_id, role, specialization, label,
           description, system_prompt, context_json, ticket_id, status,
           agent_id, session_id, claimed_at, active_since, completed_at,
           last_heartbeat, progress_note, created_at, updated_at)

-- Work groups and waves
work_groups (id, repo_id, group_id, title, description, status,
             created_by, tags_json, created_at, updated_at, current_wave)

work_group_tickets (id, work_group_id, ticket_id, added_at)
```

---

## 17. Required Changes in Agora (separate repo)

These are changes that should be implemented in the Agora repository **before or in parallel** with Agora Office development. They are Agora improvements that the visualization app needs or would benefit from.

### 17.1 REQUIRED — Emit missing events and enrich `data_json`

**Dual problem:**
1. Some event types are defined in `DashboardEvent.type` (`src/core/events.ts`) but **never emitted**: `agent_registered`, `session_changed`, `patch_proposed`. They are "dead" types.
2. Events that are emitted don't include sufficient information in `data_json`. For example, `ticket_created` doesn't include `title`, `ticket_commented` doesn't include `contentPreview`.

**Action part A — Emit missing events:**

| Event | Where to emit in Agora | Fields in `data_json` |
|---|---|---|
| `agent_registered` | `register_agent` tool handler | `agentId`, `name`, `role`, `model` |
| `session_changed` | Session start/end handlers | `sessionId`, `agentId`, `state` (active/ended) |
| `patch_proposed` | `propose_patch` tool handler | `ticketId`, `agentId`, `proposalId` |

Without these 3 events, Agora Office needs direct polling of `agents`, `sessions`, and `patches`.

**Action part B — Enrich existing events (missing fields marked with *):**

| Event | Current fields | Fields to add |
|---|---|---|
| `ticket_created` | `ticketId`, `status`, `severity`, `creatorAgentId` | `*title` |
| `ticket_status_changed` | `ticketId`, `previousStatus`, `status` | `*agentId` (who caused the change) |
| `ticket_commented` | `ticketId`, `commentId`, `agentId` | `*contentPreview` (first 100 chars) |
| `convoy_wave_started` | raw event object | `*groupId`, `*waveNumber`, `*ticketIds` |
| `convoy_agent_spawned` | raw event object | `*agentId`, `*role`, `*ticketId` |
| `convoy_completed` | raw event object | `*groupId`, `*totalTickets`, `*totalWaves` |

**Impact:** Without part A, the backend needs direct polling of 3 additional tables. Without part B, the backend needs JOIN queries to complete missing fields on each poll cycle.

### 17.2 NICE-TO-HAVE — `council_consensus_reached` event

**Problem:** There is currently no specific `dashboard_events` event for when the council reaches consensus (quorum met). The app would have to infer it by comparing verdicts with the quorum configuration.

**Action:** Add `council_consensus_reached` as a new event type in `DashboardEvent.type` and emit it from the council workflow when `check_consensus` returns `advisoryReady: true`.

**Payload:** `{ ticketId, result: 'approved' | 'vetoed', verdictSummary: {...} }`

### 17.3 NICE-TO-HAVE — `coordination_message_sent` event

**Problem:** Coordination messages between agents don't generate `dashboard_events`. The app has to poll `coordination_messages` directly with `MAX(id)` cursor.

**Action:** Add `coordination_message_sent` as an event type in `DashboardEvent` and emit it when inserting into `coordination_messages`.

**Payload:** `{ messageId, fromAgentId, toAgentId, type, payloadPreview }`

### 17.4 NICE-TO-HAVE — Stable path to Agora DB

**Problem:** The path to Agora's SQLite depends on the repo where it runs. For Agora Office, it's necessary to know where the `.agora/agora.db` of the project being observed is located.

**Action:** Document (or expose via `agora status --json`) the absolute path to the DB file. Alternatively, Agora could have a flag `agora serve --events-port 3002` that exposes `dashboard_events` as native SSE, eliminating the need for Agora Office to read the SQLite directly.

**Note:** The `agora serve` flag would turn Agora Office into a pure SSE client (no dependency on better-sqlite3 or direct filesystem access), which is cleaner but is a larger change in Agora. For v1, direct SQLite reading can be maintained.

### 17.5 FUTURE — `agora serve --events` (native SSE in Agora)

If in the future Agora Office should be completely decoupled from the filesystem, Agora could expose a built-in SSE endpoint:

```bash
agora serve --events --port 3002
```

This would emit `dashboard_events` as real-time SSE, eliminating:
- The dependency on `better-sqlite3` in Agora Office
- The need for filesystem access where Agora runs
- The complexity of the polling + diff engine
- Would allow visualizing remote Agora instances

For v1, this is out of scope. It is mentioned as a future direction.
