# Monsthera Office — Orchestration Guide

> **Purpose:** Step-by-step instructions to set up the `monsthera-office` repo, configure Monsthera, create tickets, launch agents, and run a full convoy to build the project autonomously.

**Spec:** `docs/superpowers/specs/2026-03-17-monsthera-office-design.md`
**Plan:** `docs/superpowers/plans/2026-03-17-monsthera-office.md`
**Tickets:** `docs/superpowers/plans/2026-03-17-monsthera-office-tickets.md`

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Create the Repository](#2-create-the-repository)
3. [Initialize Monsthera](#3-initialize-monsthera)
4. [Configure Governance](#4-configure-governance)
5. [Write Agent Instructions](#5-write-agent-instructions)
6. [Populate Knowledge Store](#6-populate-knowledge-store)
7. [Create Tickets](#7-create-tickets)
8. [Create Work Group and Compute Waves](#8-create-work-group-and-compute-waves)
9. [Launch Convoy](#9-launch-convoy)
10. [Sessions and Concurrency Planning](#10-sessions-and-concurrency-planning)
11. [Manual Operation (No Convoy)](#11-manual-operation-no-convoy)
12. [Using OpenCode as Agent Runtime](#12-using-opencode-as-agent-runtime)
13. [Monitoring and Intervention](#13-monitoring-and-intervention)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Prerequisites

```bash
# Required tools
node --version    # >= 20.x
pnpm --version    # >= 9.x
monsthera --version   # Monsthera CLI installed globally or via npx
```

### Agent runtime (choose one)

```bash
# Option A: Monsthera built-in loops (default)
# No extra install — monsthera loop dev/plan/council run natively

# Option B: Claude Code
claude --version

# Option C: OpenCode
opencode --version  # https://github.com/opencode-ai/opencode
```

The orchestrator spawns agents via `monsthera loop dev --ticket <id>`, which internally runs the developer-loop workflow. Each agent gets its own git worktree for isolated parallel development. See [Section 11](#11-using-opencode-as-agent-runtime) for using OpenCode instead.

---

## 2. Create the Repository

```bash
mkdir monsthera-office && cd monsthera-office
git init
echo "node_modules" > .gitignore
echo ".monsthera/" >> .gitignore

# Minimal initial commit (needed before Monsthera init)
git add .gitignore
git commit -m "chore: initial commit"
```

> **Why an initial commit?** Monsthera uses git branches and worktrees. Without at least one commit on `main`, branch creation and worktree checkout will fail.

---

## 3. Initialize Monsthera

```bash
monsthera init
monsthera index --full
```

This creates the `.monsthera/` directory with:
- `monsthera.db` — SQLite database (WAL mode) for all coordination state
- `config.json` — Governance and runtime configuration
- `agents/` — Agent instruction manifests
- `workflows/` — YAML workflow definitions (developer-loop, planner-loop, council-loop)
- `mcp-config.json` — MCP server connection config for Claude

---

## 4. Configure Governance

Edit `.monsthera/config.json`:

```json
{
  "zoektEnabled": true,
  "semanticEnabled": true,
  "coordinationTopology": "hub-spoke",

  "claimEnforceMode": "advisory",

  "ticketQuorum": {
    "enabled": true,
    "requiredPasses": 3,
    "vetoSpecializations": ["architect", "security"]
  },

  "governance": {
    "modelDiversity": {
      "strict": false,
      "maxVotersPerModel": 6
    },
    "reviewerIndependence": {
      "strict": true,
      "identityKey": "agent"
    },
    "backlogPlanningGate": {
      "enforce": true,
      "minIterations": 3,
      "requiredDistinctModels": 1
    },
    "nonVotingRoles": ["facilitator"],
    "autoAdvance": true
  },

  "convoy": {
    "maxTicketsPerWave": 5,
    "autoRefresh": true
  },

  "registrationAuth": {
    "enabled": false,
    "observerOpenRegistration": true,
    "roleTokens": {}
  }
}
```

### Key decisions:

| Setting | Value | Why |
|---------|-------|-----|
| `claimEnforceMode: "advisory"` | Warn but don't block on file claim conflicts | Tickets have well-defined `affectedPaths`, so conflicts should be rare within a wave |
| `requiredPasses: 3` | 3 reviewer approvals to merge | Balances thoroughness vs speed |
| `autoAdvance: true` | Tickets auto-advance when quorum is met | Reduces manual facilitator intervention |
| `maxTicketsPerWave: 5` | Up to 5 tickets per wave | Matches the expected 9-wave plan; wave 3 has 5 tickets |
| `autoRefresh: true` | If a ticket finishes early, pull next wave ticket | Keeps agents busy, reduces idle time |

---

## 5. Write Agent Instructions

### 5.1 Project CLAUDE.md

Create `CLAUDE.md` at the repo root:

```markdown
# Monsthera Office

Isometric pixel art web app that visualizes Monsthera multi-agent development as a virtual office.

## Architecture

Monorepo with 3 pnpm workspace packages:
- `packages/shared` — TypeScript types shared between server and client
- `packages/server` — Node + Express + better-sqlite3 reading Monsthera DB in read-only mode
- `packages/client` — React 18 + PixiJS 8 + Zustand + Vite

## Tech Stack

TypeScript (strict), React 18, PixiJS 8 (not @pixi/react), Zustand, Vite 5, Express 4, better-sqlite3, Tailwind CSS 3, pnpm workspaces.

## Conventions

- All packages use TypeScript strict mode with `noEmit` checks
- Shared types are imported from `@monsthera-office/shared`
- Server opens Monsthera's SQLite DB read-only — never writes
- Client uses Zustand stores, not React context
- PixiJS manages the canvas imperatively — React renders the UI overlay only
- Isometric tiles are 64x32 (2:1 standard), depth-sorted by `(col + row)`
- SSE events use discriminated unions with `type` field
- All colors from pastel palette: see spec section 10

## Commands

- `pnpm install` — install all dependencies
- `pnpm --filter @monsthera-office/client dev` — start Vite dev server
- `pnpm --filter @monsthera-office/server dev` — start Express server
- `pnpm build` — build all packages
- `tsc --build` — typecheck all packages (used for validation)

## Design Spec

Full spec at `docs/superpowers/specs/2026-03-17-monsthera-office-design.md`.
Read the relevant sections before implementing any ticket.

## Testing

Use `tsc --build` for type validation. Server and client packages
each have their own test setups. Run `pnpm test` from root.
```

### 5.2 Agent Manifests

Create `.monsthera/agents/` manifests for this project. The defaults from Monsthera work well, but you can customize the developer prompt:

**`.monsthera/agents/developer-loop.md`:**

```markdown
---
name: Developer Loop
description: Implements tickets for Monsthera Office — isometric pixel art visualization app.
role: developer
tags:
  - workflow
  - implementation
  - developer
  - loop
---
# Developer Loop

You are the implementation agent for Monsthera Office.

Start by running the `developer-loop` workflow to inspect suggested work.

## Project Context

This is a monorepo with 3 packages: shared, server, client.
Read the spec at `docs/superpowers/specs/2026-03-17-monsthera-office-design.md`
before implementing any ticket — it has exact field names, color values,
room layouts, and event schemas you must follow.

## Core Loop

- prefer approved tickets with explicit acceptance criteria
- claim files early before making code changes
- validate with `tsc --build` before handing off
- move the ticket to `in_review` only when acceptance criteria are met

## Avoid

- acting as reviewer or facilitator
- broad refactors outside ticket scope
- inventing new patterns — follow the spec
```

### 5.3 Council Reviewers

The default Monsthera reviewer manifests (architect, security, simplifier, performance, patterns) work out of the box. No customization needed unless you want to add project-specific review criteria.

---

## 6. Populate Knowledge Store

Before creating tickets, load the spec and plan into the knowledge store so all agents can discover project context.

```bash
# Store the spec as "context" knowledge
monsthera tool store_knowledge --input '{
  "type": "context",
  "scope": "repo",
  "title": "Monsthera Office Design Spec",
  "content": "Full-stack isometric pixel art office visualization for Monsthera. Monorepo with 3 packages (shared, server, client). Server polls Monsthera SQLite DB read-only, emits SSE events. Client renders PixiJS isometric world with 6 rooms (lobby, desks, planning, council, deploy, cafeteria). Characters represent agents, move between rooms based on ticket lifecycle. Pastel color palette, cute chibi sprites 48x48, 64x32 isometric tiles. See docs/superpowers/specs/2026-03-17-monsthera-office-design.md for full details.",
  "tags": ["monsthera-office", "spec", "architecture"]
}'

# Store the implementation plan
monsthera tool store_knowledge --input '{
  "type": "plan",
  "scope": "repo",
  "title": "Monsthera Office Implementation Plan",
  "content": "20 tickets across 9 waves. T01: scaffold monorepo. T02: shared types. T03-T06: backend (config, SSE, poller, routes). T07-T11: isometric engine (world, tilemap, sprites, pathfinding, particles). T12: Zustand stores. T13: SSE client. T14: rooms. T15: lifecycle. T16: React UI. T17: full integration. T18-T20: polish. See docs/superpowers/plans/2026-03-17-monsthera-office.md for file map and detailed steps.",
  "tags": ["monsthera-office", "plan", "implementation"]
}'

# Store key architectural decisions
monsthera tool store_knowledge --input '{
  "type": "decision",
  "scope": "repo",
  "title": "PixiJS 8 for isometric rendering",
  "content": "Use PixiJS 8 (not @pixi/react) for the isometric canvas. React handles only the UI overlay (sidebar, event log, camera controls). PixiJS manages the canvas imperatively via a world container with depth sorting by (col+row). This separation keeps rendering performant and React-free in the hot path.",
  "tags": ["monsthera-office", "pixi", "rendering", "architecture"]
}'

monsthera tool store_knowledge --input '{
  "type": "decision",
  "scope": "repo",
  "title": "SSE over WebSocket for real-time events",
  "content": "Server emits SSE (Server-Sent Events) instead of WebSocket. One-directional push is sufficient — client never sends data to server. SSE auto-reconnects natively in EventSource. Backend polls Monsthera SQLite via dashboard_events cursor + 5 complementary table diffs.",
  "tags": ["monsthera-office", "sse", "backend", "architecture"]
}'

monsthera tool store_knowledge --input '{
  "type": "decision",
  "scope": "repo",
  "title": "Read-only SQLite access to Monsthera DB",
  "content": "Monsthera Office server opens Monsthera database in read-only mode via better-sqlite3. It NEVER writes to Monsthera DB. This is a visualization tool, not a control plane. The server only reads: agents, sessions, tickets, dashboard_events, council_assignments, patches, coordination_messages.",
  "tags": ["monsthera-office", "sqlite", "backend", "security"]
}'
```

---

## 7. Create Tickets

Use `decompose_goal` with `dryRun: false` to create all 20 tickets. The full ticket definitions are in the [ticket manifest](2026-03-17-monsthera-office-tickets.md).

### Option A: Via Monsthera CLI (recommended)

```bash
monsthera tool decompose_goal --input '{
  "goal": "Build Monsthera Office: a full-stack web app that visualizes Monsthera multi-agent development activity as an isometric pixel art office with cute chibi characters, 6 themed rooms, real-time SSE connection, and animated interactions.",
  "proposedTasks": [
    {
      "title": "Scaffold monorepo with pnpm workspaces",
      "description": "Initialize the monsthera-office monorepo with pnpm workspaces. Create 3 packages: shared (shared types), server (Node+Express), client (React+PixiJS+Vite). Configure strict TypeScript, project references, and dev scripts.",
      "rationale": "Foundation for all other work. Everything depends on this.",
      "affectedPaths": ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json", "packages/shared/", "packages/server/", "packages/client/"],
      "tags": ["setup", "infra"],
      "severity": "high",
      "priority": 10,
      "dependsOn": []
    },
    ... (remaining 19 tickets from the manifest)
  ],
  "maxTickets": 20,
  "dryRun": false
}'
```

> **Note:** The full JSON payload is large. In practice, an agent reads the ticket manifest file and constructs the `proposedTasks` array programmatically.

### Option B: Via an orchestrating agent

Have an agent read the ticket manifest and call `decompose_goal`:

```
1. Read docs/superpowers/plans/2026-03-17-monsthera-office-tickets.md
2. Parse the 20 tickets with their dependencies
3. Map dependsOn references (T01→index 0, T02→index 1, etc.)
4. Call decompose_goal with dryRun: true first to validate
5. Call decompose_goal with dryRun: false to create tickets
6. Save the returned ticketIds for the next step
```

### Option C: Manual ticket creation

```bash
# Create each ticket individually
monsthera ticket create --title "Scaffold monorepo with pnpm workspaces" \
  --description "..." --severity high --priority 10 \
  --tags setup,infra --affected-paths "package.json,pnpm-workspace.yaml"

# Then link dependencies
monsthera tool link_tickets --input '{"fromTicketId": "TKT-xxx", "toTicketId": "TKT-yyy", "edgeType": "blocks"}'
```

---

## 8. Create Work Group and Compute Waves

```bash
# Collect all ticket IDs from step 7
TICKET_IDS="TKT-xxx,TKT-yyy,..."  # all 20 IDs

# Create work group
monsthera tool create_work_group --input '{
  "title": "Monsthera Office v1",
  "description": "Full-stack isometric pixel art office visualization for Monsthera multi-agent development",
  "tags": ["monsthera-office", "v1"]
}'
# Returns: groupId = "WG-xxxxxxxx"

# Add all tickets to the group
monsthera tool add_tickets_to_group --input '{
  "groupId": "WG-xxxxxxxx",
  "ticketIds": ["TKT-1", "TKT-2", ..., "TKT-20"]
}'

# Compute waves based on dependency DAG
monsthera tool compute_waves --input '{
  "groupId": "WG-xxxxxxxx"
}'
```

Expected output — 9 waves matching the dependency graph:

| Wave | Tickets | Parallel agents |
|------|---------|-----------------|
| 1 | T01 | 1 |
| 2 | T02, T03, T07 | 3 |
| 3 | T04, T08, T09, T11, T12 | 5 |
| 4 | T05, T10, T16 | 3 |
| 5 | T06, T14 | 2 |
| 6 | T13, T15 | 2 |
| 7 | T17 | 1 |
| 8 | T18, T19 | 2 |
| 9 | T20 | 1 |

---

## 9. Launch Convoy

### Fully autonomous mode (recommended)

The orchestrator manages the entire lifecycle: spawn agents, monitor progress, advance waves, merge to main.

```bash
monsthera orchestrate \
  --group WG-xxxxxxxx \
  --agents 4 \
  --test-command "pnpm exec tsc --build" \
  --test-timeout 120000 \
  --poll-interval 10000 \
  --max-retries 1
```

**What happens:**

```
┌─────────────────────────────────────────────────────────────┐
│                    ORCHESTRATOR LOOP                        │
│                                                             │
│  1. Creates integration branch: monsthera/convoy/WG-xxxxxxxx    │
│  2. Sets currentWave = 1                                    │
│                                                             │
│  For each wave:                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ a. Get wave tickets                                  │    │
│  │ b. For each ticket (up to --agents concurrent):      │    │
│  │    ┌─────────────────────────────────────────────┐   │    │
│  │    │ i.   spawn_agent → register + worktree      │   │    │
│  │    │ ii.  worktree branches from integration     │   │    │
│  │    │ iii. claim affected files (advisory)        │   │    │
│  │    │ iv.  assign ticket to agent                 │   │    │
│  │    │ v.   spawn process: monsthera loop dev          │   │    │
│  │    │      --ticket TKT-xxx --limit 1             │   │    │
│  │    │ vi.  agent implements + proposes patch       │   │    │
│  │    │ vii. council reviews (council-loop)         │   │    │
│  │    │ viii. facilitator serializes commit          │   │    │
│  │    └─────────────────────────────────────────────┘   │    │
│  │ c. Poll until all tickets: merged | failed | skipped │    │
│  │ d. advance_wave:                                     │    │
│  │    - merge queue → integration branch                │    │
│  │    - run test command                                │    │
│  │    - on failure: bisect → cascade dependents         │    │
│  │    - on success: next wave                           │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  3. Final: merge integration branch → main                  │
│  4. Report: merged N, failed M, skipped K                   │
└─────────────────────────────────────────────────────────────┘
```

### Each spawned agent's lifecycle:

```
monsthera loop dev --ticket TKT-xxx --limit 1
│
├─ register_agent (name: "spawn-developer-TKT-xxx", role: developer)
├─ run developer-loop workflow:
│   ├─ Read ticket details + acceptance criteria
│   ├─ search_knowledge("monsthera office") → load project context
│   ├─ get_code_pack → understand current codebase state
│   ├─ claim_files for affected paths
│   ├─ Implement the feature/fix
│   ├─ Validate: tsc --build
│   ├─ propose_patch with unified diff
│   └─ update_ticket_status → in_review
│
├─ Council loop triggers automatically (if autoAdvance=true):
│   ├─ architect reviewer → verdict
│   ├─ security reviewer → verdict
│   ├─ simplifier reviewer → verdict
│   ├─ (3 passes reached) → consensus
│   └─ update_ticket_status → ready_for_commit
│
├─ Facilitator processes commit queue:
│   ├─ Read validated patch
│   ├─ Apply to working tree
│   ├─ tsc --build verification
│   ├─ git commit
│   └─ update_ticket_status → resolved
│
└─ end_session
```

---

## 10. Sessions and Concurrency Planning

Each agent that registers with Monsthera gets a unique `agentId` (persistent across reconnects) and a `sessionId` (ephemeral, one per connection). The orchestrator creates these automatically when spawning agents. Understanding the session count is important for planning resources and API costs.

### 10.1 Session Anatomy

```
┌─────────────────────────────────────────────────────────────────┐
│ One Monsthera Session                                               │
│                                                                 │
│  register_agent()                                               │
│   → agentId:  agent-a1b2c3   (reused if same name reconnects)  │
│   → sessionId: session-x9y8z7 (new every time)                 │
│                                                                 │
│  Heartbeat: any MCP tool call refreshes lastActivity            │
│  Auto-reap: 3h idle → session marked "disconnected"             │
│             → file claims released                              │
│             → ticket assignments preserved (agent persists)     │
│                                                                 │
│  end_session(sessionId) → immediate cleanup                     │
└─────────────────────────────────────────────────────────────────┘
```

### 10.2 Agent Roles and How Many You Need

A full Monsthera team has 4 role types. Not all need to be active simultaneously — the orchestrator manages lifecycle automatically in convoy mode.

| Role | Purpose | Min | Recommended | Max useful |
|------|---------|-----|-------------|------------|
| **Developer** | Implement tickets, propose patches | 1 | 3-4 | 5 (one per ticket in wave) |
| **Reviewer** | Council review with specialization | 1 | 3 | 5 (architect, security, simplifier, performance, patterns) |
| **Facilitator** | Process commit queue, drive convergence | 1 | 1 | 1 |
| **Planner** | Refine backlog, approve tickets | 0* | 1 | 2 |

> \* Planner is optional when tickets are pre-approved (as in this project where tickets come from `decompose_goal` and go through the planning gate).

### 10.3 Sessions Per Wave (Monsthera Office)

The number of simultaneous sessions depends on the current wave. Each developer gets 1 session. Reviewers and facilitator run persistently across waves.

```
                    Developers    Reviewers   Facilitator    Total
                    ──────────    ─────────   ───────────    ─────
Wave 1  (T01)          1            3            1             5
Wave 2  (T02,T03,T07)  3            3            1             7
Wave 3  (T04,T08,T09,  5            3            1             9  ← PEAK
         T11,T12)
Wave 4  (T05,T10,T16)  3            3            1             7
Wave 5  (T06,T14)      2            3            1             6
Wave 6  (T13,T15)      2            3            1             6
Wave 7  (T17)          1            3            1             5
Wave 8  (T18,T19)      2            3            1             6
Wave 9  (T20)          1            3            1             5
```

**Peak concurrency: 9 sessions** (wave 3 — 5 developers + 3 reviewers + 1 facilitator).

### 10.4 Concurrency Profiles

Choose based on your API budget and hardware:

#### Minimal (budget-conscious)

```bash
monsthera orchestrate --group WG-xxx --agents 2 --test-command "pnpm exec tsc --build"
```

- **2 developers** max in parallel
- **3 reviewers** (architect + security + simplifier — minimum for quorum of 3)
- **1 facilitator**
- **Peak: 6 sessions** simultaneously
- **Trade-off:** Slower — waves with 5 tickets take ~3 passes instead of 1
- **Estimated time:** ~3-4h for all 9 waves

#### Recommended (balanced)

```bash
monsthera orchestrate --group WG-xxx --agents 4 --test-command "pnpm exec tsc --build"
```

- **4 developers** max in parallel
- **3 reviewers**
- **1 facilitator**
- **Peak: 8 sessions** simultaneously
- **Trade-off:** Good balance — only wave 3 needs a second pass (5 tickets, 4 slots)
- **Estimated time:** ~2-3h for all 9 waves

#### Maximum throughput

```bash
monsthera orchestrate --group WG-xxx --agents 5 --test-command "pnpm exec tsc --build"
```

- **5 developers** max in parallel (matches wave 3, the largest)
- **5 reviewers** (all specializations for deeper review)
- **1 facilitator**
- **Peak: 11 sessions** simultaneously
- **Trade-off:** Fastest, but highest API cost and resource usage
- **Estimated time:** ~1.5-2h for all 9 waves

### 10.5 Session Lifecycle in Convoy Mode

```
Wave N starts
│
├─ Orchestrator calls spawn_agent(ticketId) for each ticket (up to --agents)
│   ├─ Creates agent: agent-spawn-developer-TKT-xxx
│   ├─ Creates session: session-abc123
│   ├─ Creates worktree: .monsthera/worktrees/session-abc123/
│   └─ Spawns process: monsthera loop dev --ticket TKT-xxx --limit 1
│
├─ Developer works...
│   ├─ (all tool calls refresh session heartbeat)
│   ├─ Proposes patch → status: in_review
│   └─ Process exits → session stays "active" briefly
│
├─ Council reviews...
│   ├─ Reviewers submit verdicts (3 passes → consensus)
│   └─ Status: ready_for_commit
│
├─ Facilitator commits...
│   ├─ Applies patch, validates, git commit
│   └─ Status: resolved → waveStatus: merged
│
├─ Session cleanup:
│   ├─ Developer session ends (process exited)
│   ├─ Worktree cleaned up by orchestrator
│   └─ File claims released
│
└─ All tickets in wave merged → advance_wave → Wave N+1
```

### 10.6 Manual Session Planning

If running agents manually (no convoy), here's the terminal layout for the peak wave:

```
┌─────────────────────────┬─────────────────────────┐
│ Terminal 1              │ Terminal 2              │
│ Facilitator             │ Developer 1 (T04)       │
│ monsthera loop plan --watch │ monsthera loop dev          │
│                         │   --ticket TKT-xxx      │
├─────────────────────────┼─────────────────────────┤
│ Terminal 3              │ Terminal 4              │
│ Developer 2 (T08)       │ Developer 3 (T09)       │
│ monsthera loop dev          │ monsthera loop dev          │
│   --ticket TKT-yyy      │   --ticket TKT-zzz      │
├─────────────────────────┼─────────────────────────┤
│ Terminal 5              │ Terminal 6              │
│ Developer 4 (T11)       │ Developer 5 (T12)       │
│ monsthera loop dev          │ monsthera loop dev          │
│   --ticket TKT-aaa      │   --ticket TKT-bbb      │
├─────────────────────────┼─────────────────────────┤
│ Terminal 7              │ Terminal 8              │
│ Reviewer: architect     │ Reviewer: security      │
│ monsthera loop council      │ monsthera loop council      │
│   --watch               │   --watch               │
│   --specialization      │   --specialization      │
│   architect             │   security              │
├─────────────────────────┼─────────────────────────┤
│ Terminal 9                                        │
│ Reviewer: simplifier                              │
│ monsthera loop council --watch --specialization       │
│   simplifier                                      │
└───────────────────────────────────────────────────┘
```

For smaller waves (1-2 tickets), close the extra developer terminals — the reviewer and facilitator terminals stay running across waves.

### 10.7 OpenCode Session Count

When using OpenCode agents, each `opencode` process = 1 Monsthera session. The same concurrency profiles apply:

| Profile | OpenCode terminals | Monsthera loop terminals | Total |
|---------|-------------------|---------------------|-------|
| Minimal | 2 (developers) | 4 (3 reviewers + 1 facilitator) | 6 |
| Recommended | 4 (developers) | 4 (3 reviewers + 1 facilitator) | 8 |
| Maximum | 5 (developers) | 6 (5 reviewers + 1 facilitator) | 11 |

> **Tip:** You can mix runtimes. Use OpenCode for developers and Monsthera built-in loops for reviewers/facilitator, since the review workflows are deeply integrated with Monsthera's evidence-gathering pipeline.

---

## 11. Manual Operation (No Convoy)

If you prefer to run agents manually without the convoy orchestrator:

### Step 1: Run the planner loop

```bash
# Reviews backlog tickets and refines them
monsthera loop plan --watch --interval-ms 30000
```

The planner picks up `backlog` tickets, analyzes dependencies, challenges assumptions, and transitions them to `approved` when ready.

### Step 2: Run developer loops

```bash
# Terminal 1 — developer agent
monsthera loop dev --watch --interval-ms 15000 --agent-name "dev-alpha"

# Terminal 2 — second developer (parallel)
monsthera loop dev --watch --interval-ms 15000 --agent-name "dev-beta"
```

Each developer agent:
1. Finds an approved ticket with no file claim conflicts
2. Claims files, creates worktree
3. Implements the ticket
4. Proposes patch and moves to `in_review`

### Step 3: Run council reviewers

```bash
# One per specialization, watching the review queue
monsthera loop council --watch --specialization architect --agent-name "reviewer-arch"
monsthera loop council --watch --specialization security --agent-name "reviewer-sec"
monsthera loop council --watch --specialization simplifier --agent-name "reviewer-simple"
```

### Step 4: Run facilitator

```bash
monsthera loop plan --watch --agent-name "facilitator"
```

The facilitator handles:
- Processing `ready_for_commit` queue (apply patch, typecheck, commit)
- Coordinating when reviewers disagree
- Cascading failures to dependent tickets

---

## 12. Using OpenCode as Agent Runtime

[OpenCode](https://github.com/opencode-ai/opencode) is an open-source terminal AI coding tool that supports MCP servers. It can connect to Monsthera via MCP and act as a developer agent, just like Claude Code.

### 12.1 How It Works

```
┌──────────────────────────────────────────────────┐
│ Monsthera MCP Server (monsthera serve)                   │
│  ├─ SQLite DB (tickets, agents, patches, etc.)   │
│  ├─ 72 MCP tools (register_agent, claim_files..) │
│  └─ Listening on stdio or HTTP                   │
│                                                  │
│       ▲            ▲            ▲                │
│       │ MCP        │ MCP        │ MCP            │
│  ┌────┴───┐  ┌─────┴────┐  ┌───┴────────┐       │
│  │OpenCode│  │OpenCode  │  │monsthera loop  │       │
│  │ agent 1│  │ agent 2  │  │  dev       │       │
│  │(dev)   │  │(dev)     │  │(built-in)  │       │
│  └────────┘  └──────────┘  └────────────┘       │
└──────────────────────────────────────────────────┘
```

OpenCode agents and Monsthera's built-in loops can coexist — they all talk to the same MCP server and see the same tickets, coordination messages, and knowledge store.

### 12.2 Configure MCP Connection

Create `.mcp.json` in the repo root (or the worktree root):

```json
{
  "mcpServers": {
    "monsthera": {
      "command": "npx",
      "args": ["-y", "monsthera-mcp@latest", "serve", "--repo-path", "/absolute/path/to/monsthera-office"]
    }
  }
}
```

Or if Monsthera is running in HTTP mode:

```json
{
  "mcpServers": {
    "monsthera": {
      "type": "http",
      "url": "http://localhost:3141/mcp"
    }
  }
}
```

### 12.3 OpenCode Agent Instructions

Create `AGENTS.md` in the repo root. OpenCode reads this file for agent-level instructions:

```markdown
# Monsthera Office — Agent Instructions

## Setup (run at session start)

1. Call `register_agent` with your name and `desiredRole: "developer"`
2. Save the returned `agentId` and `sessionId` — use them on all subsequent calls
3. Call `search_knowledge(query="monsthera office spec")` to load project context

## Development Loop

1. Find work:
   - `list_tickets(status="approved")` → pick one with no claim conflicts
   - Or receive a specific ticket via coordination message

2. Claim ownership:
   - `assign_ticket(ticketId, agentId, sessionId)`
   - `claim_files(paths=[...affectedPaths], agentId, sessionId)`
   - `update_ticket_status(ticketId, "in_progress")`

3. Understand the ticket:
   - `get_ticket(ticketId)` → read title, description, acceptance criteria
   - `search_knowledge(query="<ticket topic>")` → find relevant context
   - Read the spec: `docs/superpowers/specs/2026-03-17-monsthera-office-design.md`

4. Implement:
   - Work in your worktree branch
   - Follow conventions in CLAUDE.md
   - Validate: `pnpm exec tsc --build`

5. Submit:
   - `propose_patch(ticketId, diff, baseCommit, agentId, sessionId)`
   - `update_ticket_status(ticketId, "in_review")`
   - `comment_ticket(ticketId, "Implementation complete. Validated with tsc --build.")`

6. End:
   - `end_session(sessionId)` when done

## Rules

- NEVER write to the Monsthera database — only use MCP tools
- Claim files BEFORE editing them
- One ticket at a time
- `tsc --build` must pass before submitting
- Read the relevant spec section before implementing
```

### 12.4 Manual Operation with OpenCode

Run OpenCode agents in separate terminals, each working on a different ticket:

```bash
# Terminal 1: Start Monsthera MCP server (if using HTTP mode)
monsthera serve --transport http --port 3141

# Terminal 2: OpenCode agent working on T03
cd /path/to/monsthera-office
opencode --prompt "Register as developer. Take ticket TKT-xxx (Backend: config and SQLite reader). Read the spec section 16 for schema reference. Implement, validate with tsc --build, and propose patch."

# Terminal 3: OpenCode agent working on T07
cd /path/to/monsthera-office
opencode --prompt "Register as developer. Take ticket TKT-yyy (Isometric engine: coordinate system). Read spec section 5 for room layout. Implement, validate, and propose patch."

# Terminal 4: OpenCode agent as reviewer
opencode --prompt "Register as reviewer with specialization architect. Poll for tickets in in_review status. Review each one for architectural boundaries and layering. Submit verdicts."
```

### 12.5 Parallel Worktrees with OpenCode

For proper isolation (like the convoy does), create worktrees manually:

```bash
# Create worktrees for parallel development
git worktree add ../monsthera-office-t03 -b ticket/TKT-xxx
git worktree add ../monsthera-office-t07 -b ticket/TKT-yyy

# Copy MCP config to each worktree
cp .mcp.json ../monsthera-office-t03/
cp .mcp.json ../monsthera-office-t07/

# Run OpenCode in each worktree
cd ../monsthera-office-t03 && opencode --prompt "..."
cd ../monsthera-office-t07 && opencode --prompt "..."
```

### 12.6 Convoy Mode with OpenCode (Custom Spawn Script)

The Monsthera orchestrator's `spawnProcess` callback is currently hard-coded to spawn `monsthera loop dev`. To use OpenCode in convoy mode, you need a wrapper script that the orchestrator can invoke.

**Create `scripts/spawn-opencode.sh`:**

```bash
#!/bin/bash
# Called by orchestrator with: spawn-opencode.sh <worktree_path> <ticket_id>
set -euo pipefail

WORKTREE_PATH="$1"
TICKET_ID="$2"
REPO_ROOT="$(git rev-parse --show-toplevel)"

# Copy MCP config to worktree
cat > "$WORKTREE_PATH/.mcp.json" << EOF
{
  "mcpServers": {
    "monsthera": {
      "command": "npx",
      "args": ["-y", "monsthera-mcp@latest", "serve", "--repo-path", "$REPO_ROOT"]
    }
  }
}
EOF

# Copy agent instructions
cp "$REPO_ROOT/AGENTS.md" "$WORKTREE_PATH/"

# Launch OpenCode with ticket-specific prompt
cd "$WORKTREE_PATH"
opencode --prompt "$(cat <<PROMPT
You are a developer agent in the Monsthera Office project.

1. Call register_agent(name="opencode-dev-$TICKET_ID", desiredRole="developer")
2. Call assign_ticket(ticketId="$TICKET_ID")
3. Call get_ticket(ticketId="$TICKET_ID") to read acceptance criteria
4. Read the spec and implement the ticket
5. Validate with: pnpm exec tsc --build
6. Call propose_patch with your diff
7. Call update_ticket_status(ticketId="$TICKET_ID", newStatus="in_review")
8. Call end_session when done
PROMPT
)" &

echo $!  # Print PID for orchestrator tracking
```

**To use this with the orchestrator**, you would need to modify Monsthera's `src/cli/orchestrator.ts` to call your script instead of `monsthera loop dev`. This is a planned extension point — currently requires a code change:

```typescript
// In src/cli/orchestrator.ts, replace the spawnProcess callback:
spawnProcess: async (worktreePath, ticketId) => {
  const child = spawn("bash", [
    path.join(config.repoPath, "scripts/spawn-opencode.sh"),
    worktreePath,
    ticketId,
  ], {
    cwd: worktreePath,
    stdio: "ignore",
    detached: true,
  });
  child.unref();

  return {
    pid: child.pid ?? 0,
    ticketId,
    sessionId: `opencode-${ticketId}`,
  };
}
```

> **Future improvement:** A `--spawn-command` flag on `monsthera orchestrate` would make this configurable without code changes. This could be contributed to Monsthera as a feature.

### 12.7 Mixed Agent Teams

You can run different agent runtimes for different roles:

| Role | Runtime | Why |
|------|---------|-----|
| Developer | OpenCode | Open-source, customizable |
| Developer | Claude Code | Strong at complex implementations |
| Reviewer | Monsthera built-in (`monsthera loop council`) | Purpose-built for evidence-gathering review |
| Facilitator | Monsthera built-in (`monsthera loop plan`) | Commit serialization requires deep Monsthera integration |
| Planner | Either | Both work for backlog refinement |

All runtimes coexist — they register as agents with different names and connect to the same Monsthera MCP server. The governance system (quorum, verdicts, auto-advance) works identically regardless of which runtime submitted the work.

```
monsthera orchestrate --group WG-xxx --agents 4
  │
  ├─ Wave 2: T02 → OpenCode agent (via custom spawn script)
  ├─ Wave 2: T03 → monsthera loop dev (built-in)
  ├─ Wave 2: T07 → OpenCode agent
  │
  ├─ Council: monsthera loop council --watch (built-in, all specializations)
  └─ Facilitator: monsthera loop plan --watch (built-in)
```

---

## 13. Monitoring and Intervention

### Dashboard

```bash
# Monsthera admin dashboard (built-in)
# Starts automatically with monsthera serve
open http://localhost:3141
```

### CLI status checks

```bash
# Overall status
monsthera status

# Ticket progress
monsthera ticket list --status approved,in_progress,in_review,ready_for_commit

# Wave status for the convoy
monsthera tool get_wave_status --input '{"groupId": "WG-xxxxxxxx"}'

# Active agents and sessions
monsthera tool agent_status --input '{"agentId": "agent-xxx"}'

# Recent events
monsthera tool list_tickets --input '{"status": "in_progress"}'
```

### Intervention scenarios

**Ticket stuck in `in_review`:**
```bash
# Check verdicts
monsthera tool list_verdicts --input '{"ticketId": "TKT-xxx"}'

# If reviewers are missing, manually trigger council
monsthera loop council TKT-xxx \
  --transition "in_review->ready_for_commit" \
  --specialization architect
```

**Agent crashed mid-work:**
```bash
# Check if session is stale (3h auto-reap)
monsthera tool agent_status --input '{"agentId": "agent-xxx"}'

# Force end session to release claims
monsthera tool end_session --input '{"sessionId": "session-xxx"}'

# Re-run the ticket
monsthera loop dev --ticket TKT-xxx --limit 1
```

**Wave stuck — one ticket blocking advancement:**
```bash
# Check wave status
monsthera tool get_wave_status --input '{"groupId": "WG-xxxxxxxx"}'

# If a ticket is truly stuck, skip it
monsthera tool update_ticket_status --input '{
  "ticketId": "TKT-xxx",
  "newStatus": "blocked",
  "comment": "Skipping for wave advancement — will fix in follow-up"
}'

# Advance wave manually
monsthera tool advance_wave --input '{"groupId": "WG-xxxxxxxx"}'
```

**Test failure on wave merge:**
```bash
# The orchestrator runs bisect automatically
# But if you need to manually fix:
git checkout monsthera/convoy/WG-xxxxxxxx
pnpm exec tsc --build
# Fix the issue, commit, then re-run advance_wave
```

---

## 14. Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `decompose_goal` rejects dependencies | Cycle in dependsOn indices | Check that T01=index 0, T02=index 1, etc. No circular refs. |
| Agent can't find project context | Knowledge store empty | Re-run step 6 to populate knowledge |
| `tsc --build` fails in worktree | Missing `pnpm install` in worktree | Ensure T01 scaffold includes proper `postinstall` or worktree setup |
| SSE client can't connect | Server not running or wrong port | Check `MONSTHERA_DB_PATH` env var and `PORT` config |
| Convoy stalls at wave N | Ticket in that wave is blocked/failed | Use `get_wave_status` to identify, then skip or fix |
| File claim conflicts | Two tickets in same wave touch same files | `compute_waves` should split these into different waves. If not, set `claimEnforceMode: "advisory"` |
| "No approved tickets" in dev loop | Planner hasn't approved them yet | Run `monsthera loop plan` first, or manually approve with `update_ticket_status` |
| Agent registers as observer | `registrationAuth.enabled` but no token | Disable auth or provide `authToken` in registration |

---

## Quick Reference: Full Convoy Launch Script

```bash
#!/bin/bash
set -euo pipefail

REPO_DIR="$(pwd)"
SPEC_DIR="docs/superpowers/specs"
PLAN_DIR="docs/superpowers/plans"

echo "=== Monsthera Office Convoy Setup ==="

# 1. Init Monsthera
monsthera init
monsthera index --full

# 2. Populate knowledge (abbreviated — see step 6 for full commands)
echo "Populating knowledge store..."
monsthera tool store_knowledge --input '{
  "type": "plan",
  "scope": "repo",
  "title": "Monsthera Office Implementation Plan",
  "content": "20 tickets, 9 waves. See docs/superpowers/plans/2026-03-17-monsthera-office.md",
  "tags": ["monsthera-office", "plan"]
}'

# 3. Create tickets via decompose_goal
# (Agent reads ticket manifest and calls decompose_goal)
echo "Creating tickets..."
# monsthera tool decompose_goal --input '{ ... }'  # see step 7

# 4. Create work group
echo "Creating work group..."
GROUP_ID=$(monsthera tool create_work_group --input '{
  "title": "Monsthera Office v1",
  "description": "Isometric pixel art office visualization"
}' | jq -r '.groupId')

# 5. Add tickets and compute waves
echo "Computing waves..."
monsthera tool add_tickets_to_group --input "{
  \"groupId\": \"$GROUP_ID\",
  \"ticketIds\": [$(monsthera ticket list --status backlog --format ids)]
}"
monsthera tool compute_waves --input "{\"groupId\": \"$GROUP_ID\"}"

# 6. Launch convoy
echo "Launching convoy..."
monsthera orchestrate \
  --group "$GROUP_ID" \
  --agents 4 \
  --test-command "pnpm exec tsc --build" \
  --poll-interval 10000

echo "=== Done ==="
```

---

## Agent Roles Summary

| Role | Count | Loop Command | Responsibility |
|------|-------|-------------|----------------|
| Developer | 1-4 (per wave) | `monsthera loop dev --ticket TKT-xxx` | Implement ticket, propose patch |
| Architect Reviewer | 1 | `monsthera loop council --specialization architect` | Review boundaries, layering |
| Security Reviewer | 1 | `monsthera loop council --specialization security` | Review auth, input validation (VETO power) |
| Simplifier Reviewer | 1 | `monsthera loop council --specialization simplifier` | Review code clarity, remove complexity |
| Performance Reviewer | 1 | `monsthera loop council --specialization performance` | Review rendering perf, memory |
| Patterns Reviewer | 1 | `monsthera loop council --specialization patterns` | Review consistency with codebase patterns |
| Facilitator | 1 | `monsthera loop plan --watch` | Process commit queue, drive convergence |
| Planner | 1-2 | `monsthera loop plan --watch` | Refine backlog, approve tickets |

**In convoy mode**, the orchestrator handles agent lifecycle automatically. These roles are described here for manual operation or debugging.

---

## Convoy vs Manual: When to Use Which

| Scenario | Approach |
|----------|----------|
| First-time demo, want full automation | Convoy (`monsthera orchestrate`) |
| Debugging a specific ticket | Manual (`monsthera loop dev --ticket TKT-xxx`) |
| Wave 1 (scaffold only) | Manual — do T01 by hand, then convoy for the rest |
| Need to customize agent behavior | Manual with custom `--agent-name` |
| Production run, hands-off | Convoy with `--max-retries 2` |

> **Recommendation:** Do T01 (scaffold) manually to ensure the monorepo foundation is solid. Then launch the convoy starting at wave 2 for the remaining 19 tickets.
