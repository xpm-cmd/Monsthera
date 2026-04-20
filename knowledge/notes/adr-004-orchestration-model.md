---
id: k-40emzavw
title: ADR-004: Orchestration Model
slug: adr-004-orchestration-model
category: architecture
tags: [orchestration, waves, autoadvance, guards, events, agents]
codeRefs: [src/orchestration/service.ts, src/orchestration/types.ts, src/orchestration/repository.ts, src/orchestration/in-memory-repository.ts, src/persistence/dolt-orchestration-repository.ts, src/tools/orchestration-tools.ts, src/agents/service.ts, src/work/lifecycle.ts, src/work/templates.ts]
references: []
sourcePath: docs/adrs/004-orchestration-model.md
createdAt: 2026-04-10T23:03:46.493Z
updatedAt: 2026-04-11T02:15:05.813Z
---

## ADR-004: Orchestration Model

Status: Accepted | Date: 2026-04-07

### What ships today

The orchestration layer implements **wave-based phase advancement** with guard evaluation and an optional auto-advance polling loop. It does NOT implement dispatch or convoy patterns — the current model is pull-based: the service scans for ready work, plans a batch of transitions (a "wave"), and executes them with bounded concurrency.

### Core components

**OrchestrationService** (`src/orchestration/service.ts`) is the central coordinator. It depends on a `WorkArticleRepository` (to find and advance work articles) and an `OrchestrationEventRepository` (to record audit events). Key configuration:

- `autoAdvance` (default false) — enables the polling loop
- `pollIntervalMs` (default 30000) — interval between auto-advance cycles
- `maxConcurrentAgents` (default 5, minimum 1) — concurrency cap for wave execution

### How scanActiveWork finds ready articles

`scanActiveWork()` delegates to `workRepo.findActive()`, which returns all work articles NOT in terminal phases (`done` or `cancelled`). This is the entry point for wave planning — it provides the candidate set.

### How checkReadiness evaluates guards

`evaluateReadiness(id)` checks whether a single work article is ready to advance to the next sequential phase:

1. Loads the article by ID from the work repo.
2. Calls `getNextPhase(article.phase)` to determine the target phase. The lifecycle is linear: `planning -> enrichment -> implementation -> review -> done`. If the article is already terminal, `nextPhase` is null and `ready` is false.
3. Calls `getGuardSet(article, currentPhase, nextPhase)` from `src/work/lifecycle.ts` to get the guards for that transition.
4. Evaluates each guard's `check(article)` function. All must pass for the article to be `ready`.
5. Logs a `guard_evaluated` event with the results.
6. Returns a `ReadinessReport` containing `workId`, `currentPhase`, `nextPhase`, `ready`, and `guardResults[]`.

**Guard sets per transition:**

| Transition | Guards |
|---|---|
| planning -> enrichment | `has_objective` + `has_acceptance_criteria` (if template requires it) |
| enrichment -> implementation | `min_enrichment_met` (checks enrichment count >= template's `minEnrichmentCount`) |
| implementation -> review | `implementation_linked` (codeRefs must be non-empty) |
| review -> done | `all_reviewers_approved` (every reviewer must have approved) |

Cancellation (`any -> cancelled`) bypasses all guards.

### How planWave builds batched phase transitions

`planWave(opts?)` builds a `WavePlan` containing items ready to advance and items that are blocked:

1. Calls `scanActiveWork()` to get all non-terminal articles.
2. Loads ALL articles via `workRepo.findMany()` to build a set of terminal IDs (done/cancelled) for dependency resolution.
3. For each active article:
   - **Dependency check**: if `article.blockedBy` contains any IDs NOT in the terminal set, the article is added to `blockedItems` with a reason string listing the unresolved blockers.
   - **Auto-advance filter** (when `opts.autoAdvanceOnly` is true): skips articles whose template has `autoAdvance: false`. Currently ALL four templates (feature, bugfix, refactor, spike) have `autoAdvance: false`, so auto-advance is effectively a no-op unless a template is configured for it.
   - **Guard evaluation**: gets the next phase and evaluates all guards. If all pass, the item is added to `items[]` with `{ workId, from, to }`.
4. Logs a `guard_evaluated` event with `readyCount` and `blockedCount` under `workId: "wave"`.
5. Returns `WavePlan { items, blockedItems }`.

### How executeWave runs transitions with bounded concurrency

`executeWave(plan)` executes the transitions in a WavePlan:

1. Creates a **worker pool** of size `min(maxConcurrentAgents, plan.items.length)`.
2. Workers pull items from a shared index counter (simple cooperative concurrency — no lock needed because JS is single-threaded between awaits).
3. For each item, the worker:
   - **Staleness check**: re-reads the article from the repo and verifies its phase still matches `item.from`. If the phase changed since planning, it goes to `failed[]`.
   - Calls `tryAdvance(item.workId)` which re-evaluates readiness, advances the phase via `workRepo.advancePhase()`, and logs `phase_advanced` or `error_occurred` events.
4. Returns `WaveResult { advanced[], failed[] }`.

### How autoadvance polls on an interval

When `autoAdvance` is true, calling `start()`:

1. Sets `running = true` and starts a `setInterval` at `pollIntervalMs`.
2. Each tick: calls `planWave({ autoAdvanceOnly: true })`, and if any items are ready, calls `executeWave(plan)`.
3. Errors in the loop are caught and logged, never thrown.
4. `stop()` clears the interval and sets `running = false`.

### Event audit trail

Every significant orchestration action records an event via `OrchestrationEventRepository.logEvent()`. Events have an auto-generated ID and timestamp.

**Event types** (`OrchestrationEventType`):

| Type | When recorded |
|---|---|
| `phase_advanced` | After successful phase transition (from/to in details) |
| `guard_evaluated` | After readiness evaluation or wave planning |
| `error_occurred` | When tryAdvance fails (operation + error message in details) |
| `agent_spawned` | Agent lifecycle (available but not emitted by current code) |
| `agent_completed` | Agent lifecycle (available but not emitted by current code) |
| `dependency_blocked` | Dependency change (available but not emitted by current code) |
| `dependency_resolved` | Dependency change (available but not emitted by current code) |

**Storage backends:**

- `InMemoryOrchestrationEventRepository` — capped at 10,000 events with 90% retention on eviction. Queries: by workId, by eventType, or recent (sorted desc).
- `DoltOrchestrationRepository` — persists to a MySQL-compatible `orchestration_events` table via Dolt. Same query interface, details stored as JSON.

### MCP tools exposed

`src/tools/orchestration-tools.ts` exposes two tools:

- **`log_event`** — manually log an orchestration event (workId, eventType, details, optional agentId).
- **`get_events`** — query events by workId, eventType, or get recent N (default 50, max 1000).

### Agent registry

`AgentService` (`src/agents/service.ts`) derives agent profiles from work article participation, not from an explicit registry. It scans all work articles to find participants (author, lead, assignee, reviewers, enrichment roles) and combines that with recent orchestration events to build an `AgentDirectory` with per-agent profiles showing status, touchpoints, roles, and recent activity.

### Type definitions

Core types from `src/orchestration/types.ts`:

- **`ReadinessReport`** — workId, currentPhase, nextPhase (nullable), ready boolean, guardResults array
- **`AdvanceResult`** — workId, from phase, to phase, updated article
- **`WavePlan`** — items (ready transitions) + blockedItems (with reasons)
- **`WaveResult`** — advanced (successful) + failed (with error messages)