---
id: k-qlgfto92
title: Work Article Guard System
slug: work-article-guard-system
category: context
tags: [work-articles, guards, phase-transitions, lifecycle, state-machine]
codeRefs: [src/work/guards.ts, src/work/lifecycle.ts, src/work/phase-history.ts, src/work/lockfile-hashes.ts, src/work/templates.ts]
references: [k-n3gtykv5, work-phase-history-and-skipped-guard-audit-trail]
createdAt: 2026-04-11T02:15:07.451Z
updatedAt: 2026-04-20T00:00:00.000Z
---

## Overview

The guard system gates phase transitions in work articles. Guards are pure boolean functions that inspect a `WorkArticle` and return whether a transition should be allowed. They are composed per-transition by the lifecycle layer in `getGuardSet()`.

## Guard Functions

All guards live in `src/work/guards.ts` and have the signature `(article: WorkArticle) => boolean`.

### Content Guards

**`has_objective(article)`**
- Checks: `article.content.includes("## Objective")`
- Used in: planning -> enrichment (all templates)
- Purpose: Ensures the work article has a stated objective before any enrichment work begins.

**`has_acceptance_criteria(article)`**
- Checks: `article.content.includes("## Acceptance Criteria")`
- Used in: planning -> enrichment (only if template's `requiredSections` includes "Acceptance Criteria")
- Purpose: Ensures testable success criteria exist. Skipped for `spike` template since spikes define "Research Questions" instead.

### Enrichment Guards

**`min_enrichment_met(article, min)`**
- Checks: counts `enrichmentRoles` where `status === "contributed" || status === "skipped"`, returns `count >= min`
- Used in: enrichment -> implementation
- The `min` threshold comes from the template's `minEnrichmentCount` (0 for spike, 1 for all others)
- Note: "skipped" counts toward the minimum -- this allows agents to explicitly decline a role without blocking progress.

### Implementation Guards

**`implementation_linked(article)`**
- Checks: `article.content.includes("## Implementation")`
- Used in: implementation -> review
- Purpose: Ensures implementation details (code refs, approach, etc.) are documented before review begins.

### Review Guards

**`all_reviewers_approved(article)`**
- Checks: `article.reviewers.length > 0 && article.reviewers.every(r => r.status === "approved")`
- Used in: review -> done
- Two conditions: (1) at least one reviewer must be assigned, (2) ALL assigned reviewers must have approved.
- If any reviewer has `changes-requested`, the transition is blocked until they re-approve.

### Async Snapshot Guard

**`snapshot_ready(article, deps)`**
- Signature: `async (article, deps?: SnapshotGuardDeps) => Promise<boolean>` — the only async guard in the system.
- Used in: enrichment -> implementation, **but only for templates that opt in** via `requiresSnapshotForImplementation: true` in `src/work/templates.ts`. Today that is the `feature` template only; `bugfix`, `refactor`, and `spike` flows stay untouched.
- Dependencies (`SnapshotGuardDeps`, defined in `guards.ts`):
  - `snapshotService` — the `SnapshotService` that reads the latest recorded snapshot for this work article
  - `headLockfileHashes` — a pre-computed `{ path: sha256 }` map for well-known lockfiles at HEAD, produced by `readHeadLockfileHashes()` in `src/work/lockfile-hashes.ts` (walks `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Cargo.lock`, `go.sum`; missing files are silently skipped)
- Passes only when all three hold:
  1. a snapshot exists for the work article (`snapshotService.getLatest({ workId })` returns a value)
  2. the snapshot is not flagged `stale` (age check driven by `MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES`, default 30 min; `0` disables the freshness check)
  3. every HEAD lockfile hash matches the one recorded in the snapshot. Lockfiles present at HEAD but missing from the snapshot fail closed.
- Fail-closed behaviour: when `snapshotService` is not wired, the guard returns `false` rather than silently passing.
- Failure emits `SNAPSHOT_READY_RECOVERY_HINT`, an exported constant that points agents at `scripts/capture-env-snapshot.ts` and the `record_environment_snapshot` MCP tool so the recovery message has a single source of truth.
- Bypassable via `--skipGuard` (CLI: `--skip-guard-reason <text>` on `work advance`, or the sanctioned `work close` command). The bypass writes `snapshot_ready` into `phase_history[].skipped_guards` alongside the operator's reason.

## Guard Composition per Transition

The `getGuardSet(article, from, to)` function in `src/work/lifecycle.ts` returns a `GuardEntry[]` for each transition:

| Transition | Guards (in order) | Template-dependent? |
|---|---|---|
| planning -> enrichment | `has_objective`, then `has_acceptance_criteria` | Yes -- acceptance criteria only if template requires it |
| enrichment -> implementation | `min_enrichment_met(minEnrichmentCount)`, then (opt-in) `snapshot_ready` | Yes -- threshold varies by template; `snapshot_ready` appended only when `requiresSnapshotForImplementation` is true |
| implementation -> review | `implementation_linked` | No |
| review -> done | `all_reviewers_approved` | No |
| * -> cancelled | (empty array) | No |

## Guard Evaluation

Guards are evaluated sequentially in `checkTransition()`. The first guard that returns `false` causes the entire transition to fail with a `GuardFailedError` that names the failing guard. This means:

- Earlier guards in the array are checked first
- A single failure is enough to block the transition
- The error message identifies which specific guard failed, enabling targeted fixes

## GuardEntry Interface

```typescript
interface GuardEntry {
  readonly name: string;           // e.g. "has_objective"
  readonly check: (article: WorkArticle) => boolean;
}
```

The `name` field is used in error messages so agents can understand what precondition is missing.

## Design Notes

- Guards are stateless pure functions -- they only inspect the article, never mutate it.
- The lifecycle layer wraps guards with template awareness (e.g., consulting `WORK_TEMPLATES[article.template]` to decide which guards to include).
- Cancellation explicitly bypasses all guards -- any non-terminal article can be cancelled immediately.

<!-- codex-related-articles:start -->
## Related Articles

- [[work-phase-history-and-skipped-guard-audit-trail]]
- [[adr-002-work-article-model]]
<!-- codex-related-articles:end -->
