---
id: k-4e666q5w
title: Wave Planning and Execution System
slug: wave-planning-and-execution-system
category: context
tags: [orchestration, waves, concurrency, guards, phase-transitions]
codeRefs: [src/orchestration/service.ts, src/orchestration/types.ts, src/work/lifecycle.ts, src/work/templates.ts]
references: [k-40emzavw]
createdAt: 2026-04-11T02:15:52.628Z
updatedAt: 2026-04-11T02:15:52.628Z
---

## Wave Planning and Execution

The wave system is the core mechanism for batching and executing phase transitions across multiple work articles. It lives in `OrchestrationService` (`src/orchestration/service.ts`).

### Mental model

A "wave" is a single pass through all active work: scan candidates, evaluate guards, build a plan, then execute the ready transitions with bounded concurrency. Waves are idempotent-safe — staleness checks at execution time prevent double-advances.

### planWave: building the transition batch

`planWave(opts?)` returns a `WavePlan` with two lists:

**1. Candidate collection** — calls `scanActiveWork()` which returns articles NOT in terminal phases (done/cancelled).

**2. Dependency resolution** — loads ALL articles to build a set of terminal IDs. For each active article, checks `article.blockedBy` against this set. Any article with unresolved (non-terminal) blockers goes to `blockedItems` with a human-readable reason like `"Blocked by: w-abc123, w-def456"`.

**3. Template filtering** — when `opts.autoAdvanceOnly` is true (used by the auto-advance polling loop), articles whose template has `autoAdvance: false` are skipped entirely. As of now, all four templates (feature, bugfix, refactor, spike) set `autoAdvance: false`, making the auto-advance loop a no-op by default. This is an intentional safety measure — templates must opt in.

**4. Guard evaluation** — for each non-blocked, non-filtered article:
- Determines the next phase via `getNextPhase()` (linear: planning -> enrichment -> implementation -> review -> done)
- Gets the guard set for that transition from `getGuardSet(article, from, to)` in `src/work/lifecycle.ts`
- Evaluates every guard's `check(article)` function
- If ALL guards pass, adds `{ workId, from, to }` to `items[]`

**Output**: `WavePlan { items: [...ready], blockedItems: [...blocked] }`

### executeWave: bounded-concurrency execution

`executeWave(plan)` takes a WavePlan and runs the transitions:

**Worker pool pattern**: creates `min(maxConcurrentAgents, plan.items.length)` workers. Each worker loops pulling the next item from a shared counter. This is safe without locks because Node.js is single-threaded between `await` points — by the time a worker increments the index and reads the item, no other worker can interleave.

**Per-item processing**:

1. **Staleness guard**: re-reads the article from the repo and verifies `currentPhase === item.from`. If the phase changed between planning and execution (another agent advanced it, manual intervention, etc.), the item goes to `failed[]` with a descriptive error.

2. **Advance attempt**: calls `tryAdvance(item.workId)` which:
   - Re-evaluates readiness (calls `evaluateReadiness` again — double-checking guards)
   - If not ready, returns `GuardFailedError` with the failing guard names
   - If ready, calls `workRepo.advancePhase(workId, nextPhase)` to mutate the article
   - Logs a `phase_advanced` event on success or `error_occurred` on failure

3. **Result collection**: successful advances go to `advanced[]`, failures to `failed[]`.

**Output**: `WaveResult { advanced: AdvanceResult[], failed: { workId, error }[] }`

### Key properties

- **Double-checked guards**: guards are evaluated at planning time AND again at execution time (via `tryAdvance` -> `evaluateReadiness`). This prevents acting on stale guard results.
- **Bounded concurrency**: `maxConcurrentAgents` (default 5) prevents unbounded parallel DB writes. Configured at service construction.
- **Audit trail**: every guard evaluation, phase advance, and error is logged as an `OrchestrationEvent` with timestamps and details.
- **No partial rollback**: if some items in a wave fail, the successful ones remain advanced. Failed items are reported in the result but not retried automatically.
- **Idempotent-safe**: the staleness check at execution time means running the same plan twice won't double-advance articles.

### Type definitions

```typescript
interface WavePlan {
  items: { workId: string; from: WorkPhase; to: WorkPhase }[];
  blockedItems: { workId: string; reason: string }[];
}

interface WaveResult {
  advanced: AdvanceResult[];  // { workId, from, to, article }
  failed: { workId: string; error: string }[];
}
```

### Integration with autoadvance

The auto-advance loop (`start()`) calls `planWave({ autoAdvanceOnly: true })` on a timer (default 30s). It only executes if the plan has items. Since all current templates have `autoAdvance: false`, this loop is dormant unless a template is configured to opt in. Manual wave execution via `planWave()` + `executeWave()` (without autoAdvanceOnly) skips the template filter and will process any article whose guards pass.