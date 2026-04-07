# Phase 7: Orchestration — Session Prompt

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
| 6 | Surfaces | Complete | `e6275d3` |
| 7 | Orchestration | **This phase** |
| 8 | Migration | Pending |
| 9 | Hardening | Pending |

**Branch:** `rewrite/v3`
**Test count:** 639 tests, 33 test files, all passing
**Typecheck:** Clean (`pnpm typecheck` passes with zero errors)

## Canonical documents (read these first)

All in `MonstheraV3/` directory (untracked, present on disk):

1. **`monsthera-architecture-v6-final.md`** — Full architecture. Section 10 defines the orchestration model.
2. **`monsthera-ticket-as-article-design.md`** — Work article design, lifecycle, enrichment, and review models.
3. **`monsthera-v3-implementation-plan-final.md`** — Implementation plan. Section 4, Phase 7 deliverables.

## What Phase 7 must deliver

### 7.1 Guard evaluation service

Guards already exist as pure functions in `src/work/guards.ts`:
- `has_objective(article)` — checks for `## Objective` section
- `has_acceptance_criteria(article)` — checks for `## Acceptance Criteria` section
- `min_enrichment_met(article, min)` — checks enrichment contributions >= min
- `implementation_linked(article)` — checks for `## Implementation` section
- `all_reviewers_approved(article)` — checks all reviewers are approved

The lifecycle module (`src/work/lifecycle.ts`) already composes guards into transition checks via `checkTransition(article, targetPhase)`. It uses guard sets per transition (planning→enrichment, enrichment→implementation, etc.).

Phase 7 needs a **guard evaluation service** that:
- Wraps the existing pure guard functions
- Provides a high-level API: `evaluateReadiness(workId) → { ready: boolean, phase: string, failedGuards: string[] }`
- Logs guard evaluation events to the orchestration event repository
- Is testable in isolation (pure logic + event logging side effect)

### 7.2 Orchestration service

Create `src/orchestration/service.ts` as the central orchestration coordinator:

```typescript
class OrchestrationService {
  // Scan all active (non-terminal) work articles
  scanActiveWork(): Promise<Result<WorkArticle[], StorageError>>

  // Evaluate if a work article is ready to advance
  evaluateReadiness(id: string): Promise<Result<ReadinessReport, NotFoundError | StorageError>>

  // Advance a work article if guards pass (with event logging)
  tryAdvance(id: string): Promise<Result<AdvanceResult, NotFoundError | StateTransitionError | GuardFailedError | StorageError>>

  // Plan a wave: group ready-to-advance items and return execution plan
  planWave(): Promise<Result<WavePlan, StorageError>>

  // Execute a wave plan (advance items, spawn agents if configured)
  executeWave(plan: WavePlan): Promise<Result<WaveResult, StorageError>>
}
```

### 7.3 Orchestration loop

The orchestrator should support:
- **Manual mode** (default): operator triggers `tryAdvance` or `executeWave` explicitly
- **Auto-advance mode** (opt-in via `config.orchestration.autoAdvance`): periodic polling loop
  - Poll interval from `config.orchestration.pollIntervalMs` (default: 30000)
  - Start/stop lifecycle methods
  - Graceful shutdown on container dispose

### 7.4 Wave planning

A wave is a batch of work articles that can advance simultaneously:
- Scan active work
- Filter to items where guards pass
- Respect dependency ordering (blocked items cannot be in the wave)
- Return a `WavePlan` with ordered items and their target phases
- Log wave planning events

### 7.5 Event logging

The orchestration event repository already exists (`src/orchestration/repository.ts`) with types:
- `phase_advanced` — a work article changed phase
- `agent_spawned` — an agent was spawned for a task
- `agent_completed` — an agent completed its task
- `dependency_blocked` — a work item is blocked by a dependency
- `dependency_resolved` — a dependency was resolved
- `guard_evaluated` — guards were checked for a transition
- `error_occurred` — an error during orchestration

The MCP tools for logging/querying events already exist (`src/tools/orchestration-tools.ts`).

Phase 7 should ensure the orchestration service **proactively logs events** during:
- Guard evaluation
- Phase advancement
- Wave planning and execution
- Error scenarios

### 7.6 Wire into container

Update `src/core/container.ts` to:
- Create and expose `OrchestrationService` in the container interface
- Wire it with `workService`, `orchestrationRepo`, and `logger`
- If `config.orchestration.autoAdvance` is true, start the polling loop
- On dispose, stop the polling loop

## Key files to read

| File | Purpose |
|------|---------|
| `src/core/container.ts` | Dependency container — wire new service here |
| `src/core/config.ts` | Config schema — `orchestration` section already defined |
| `src/work/guards.ts` | Pure guard functions (5 guards) |
| `src/work/lifecycle.ts` | Phase transition logic with guard composition |
| `src/work/service.ts` | Work domain service (advancePhase, etc.) |
| `src/work/repository.ts` | WorkArticle type, WorkArticleRepository interface |
| `src/orchestration/repository.ts` | OrchestrationEvent types, repository interface |
| `src/orchestration/in-memory-repository.ts` | In-memory event repo implementation |
| `src/tools/orchestration-tools.ts` | MCP tools for event logging/querying |
| `src/server.ts` | MCP server — may need to register new orchestration tools |

## Architecture rules (Section 10)

1. **Guards are pure, deterministic, and testable** — no side effects in guard functions
2. **Orchestrator is conservative** — prefers explicit readiness, opt-in auto-advance
3. **Observable behavior** — all transitions and decisions are logged as events
4. **Operator override** — manual mode is always available, auto-advance is opt-in
5. **No domain logic in surfaces** — the orchestration service owns all coordination logic

## Existing patterns to follow

- All service methods return `Result<T, E>` — never throw
- Services take dependencies via constructor injection (repo, logger, other services)
- Container creates and wires all services
- Tests use in-memory repositories and a `noopLogger`
- Event logging uses `OrchestrationEventRepository.logEvent()`

## Data types to define

```typescript
interface ReadinessReport {
  readonly workId: string;
  readonly currentPhase: WorkPhase;
  readonly nextPhase: WorkPhase | null;
  readonly ready: boolean;
  readonly guardResults: Array<{ name: string; passed: boolean }>;
}

interface AdvanceResult {
  readonly workId: string;
  readonly from: WorkPhase;
  readonly to: WorkPhase;
  readonly article: WorkArticle;
}

interface WavePlan {
  readonly items: Array<{
    readonly workId: string;
    readonly from: WorkPhase;
    readonly to: WorkPhase;
  }>;
  readonly blockedItems: Array<{
    readonly workId: string;
    readonly reason: string;
  }>;
}

interface WaveResult {
  readonly advanced: AdvanceResult[];
  readonly failed: Array<{ workId: string; error: string }>;
}
```

## Workflow

1. Claude (Opus) plans each sub-deliverable
2. Claude implements using agents for parallel work
3. Submit to Codex for review (`node codex-companion.mjs review`)
4. Fix all findings
5. Run `pnpm test && pnpm typecheck` before committing
6. Commit with descriptive message

## Test expectations

- Guard evaluation service: test each guard individually and in combination
- Orchestration service: test scanActiveWork, evaluateReadiness, tryAdvance
- Wave planning: test dependency ordering, blocked item filtering
- Orchestration loop: test start/stop lifecycle, polling behavior
- Event logging: verify events are emitted for all orchestration actions
- Target: ~30-40 new tests
