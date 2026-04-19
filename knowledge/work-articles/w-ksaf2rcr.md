---
id: w-ksaf2rcr
title: Agent-facing docs and recovery hints for the snapshot surface
template: refactor
phase: review
priority: medium
author: agent-claude-followups
tags: [snapshot, agents, docs, ux, followup, iris-research]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-19T09:45:28.096Z
updatedAt: 2026-04-19T09:49:52.903Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"agent-claude-followups","status":"contributed","contributedAt":"2026-04-19T09:45:58.484Z"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-19T09:45:28.096Z","exitedAt":"2026-04-19T09:45:56.208Z"},{"phase":"enrichment","enteredAt":"2026-04-19T09:45:56.208Z","exitedAt":"2026-04-19T09:46:00.704Z"},{"phase":"implementation","enteredAt":"2026-04-19T09:46:00.704Z","exitedAt":"2026-04-19T09:49:52.903Z"},{"phase":"review","enteredAt":"2026-04-19T09:49:52.903Z"}]}
---

## Objective

Close the three UX gaps a cold-start agent hits when trying to use the environment-snapshot surface: (a) the operating guide does not mention snapshots, (b) the `snapshot_ready` guard fails with a generic message that does not suggest the recovery, and (c) there is no single runbook that chains capture → record → `build_context_pack`. All three are agent-facing, not human-facing.

## Motivation

The four follow-ups to PR #59 shipped the surface (Dolt persistence, opt-in guard, dashboard drift band, benchmark plan). Each individual tool description and each ADR is clear, but the orchestration is implicit — an agent arriving cold has to cross three documents to figure out the call sequence. Specifically:

- `knowledge/notes/monsthera-agent-operating-guide.md` (`k-uuz80fga`) predates the snapshot work and does not mention it at all.
- `GuardFailedError("snapshot_ready")` emitted by `evaluateAsyncGuards` has a fixed template message. An agent reading it has no hint that the fix is to run `scripts/capture-env-snapshot.ts` and pipe into `record_environment_snapshot`.
- There is no "3 steps" runbook in any single place.

## Acceptance Criteria

- [ ] `k-uuz80fga` gains an "Environment snapshots" section covering:
  - When to capture a snapshot (before starting implementation on a feature work article, before handoff, on sandbox resume).
  - The exact 3-call sequence: `scripts/capture-env-snapshot.ts` → `record_environment_snapshot` → `build_context_pack(work_id, agent_id)`.
  - How the opt-in guard interacts (which templates gate on it, how `skipGuard` bypass is audited).
  - Pointer to the dashboard drift band and when it fires.
- [ ] `AsyncGuardEntry` gains an optional `recoveryHint?: string` field. When present, the hint is appended to the error message emitted by `evaluateAsyncGuards`, so a caller seeing `GUARD_FAILED` can act without reading ADR-006.
- [ ] `getAsyncGuardSet` populates `recoveryHint` on the `snapshot_ready` entry with the concrete recovery command.
- [ ] Unit tests cover the hint being appended to the error message and the absence of the hint not breaking existing guards.
- [ ] No breaking change to `AsyncGuardEntry`, `GuardDeps`, or any consumer of `evaluateAsyncGuards`. The field is optional.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` pass.
- [ ] CHANGELOG entry under `[Unreleased]`.

## Constraints

- MCP server does not shell out. The recovery-hint text can reference `scripts/capture-env-snapshot.ts` but the server itself still does not execute shells.
- Do NOT move `src/context/`, do NOT touch `InMemorySnapshotRepository`, do NOT widen the `SnapshotRepository` interface — all three are explicitly off-limits per the follow-up rules.
- Do NOT add a new tool. Recovery is communicated via the error message and the agent guide.
- Do NOT rewrite the existing operating guide sections. Additive only.

## Files to Modify

- `knowledge/notes/monsthera-agent-operating-guide.md` — add "Environment snapshots" section before "Continuous improvement loop".
- `src/work/lifecycle.ts` — extend `AsyncGuardEntry`; append hint to `GuardFailedError.message`.
- `src/work/guards.ts` — export a `SNAPSHOT_READY_RECOVERY_HINT` constant so the guard-set builder and the tests share one source of truth.
- `tests/unit/work/snapshot-ready-guard.test.ts` — new assertions: the error message contains the hint when the guard fires; no hint on guards without one.
- `CHANGELOG.md` — Added + Changed entries.

## Review Checklist

- [x] Agent guide reads coherent when the new section is dropped in — no duplicated headings, consistent voice.
- [x] Error message format stays parseable (hint is suffixed, does not break downstream log parsers).
- [x] No `any` types introduced.
- [x] Existing 9 guard tests + 6 service tests still pass with the new message shape.

## Implementation

Landed on branch `claude/env-snapshot-followups-r2osu-5-agent-docs`.

Changes:

- `src/work/guards.ts` — new exported constant `SNAPSHOT_READY_RECOVERY_HINT` so the guard-set builder and tests share one source of truth for the recovery text.
- `src/work/lifecycle.ts` — `AsyncGuardEntry.recoveryHint?: string` (additive; existing guards without a hint are unchanged). `evaluateAsyncGuards` appends `. <hint>` to the `GuardFailedError.message` only when the failing entry carries one. `getAsyncGuardSet` populates the hint on the `snapshot_ready` entry.
- `tests/unit/work/snapshot-ready-guard.test.ts` — +2 tests: the error message contains the full hint when the guard fires; `getAsyncGuardSet` exposes the hint on the returned entry.
- `knowledge/notes/monsthera-agent-operating-guide.md` (`k-uuz80fga`) — new "Environment snapshots" section before "Continuous improvement loop" covering the 3-step runbook (capture → record → `build_context_pack`), the `snapshot_ready` guard and its recovery / bypass semantics, `compare_environment_snapshots`, the dashboard drift endpoint, and Dolt persistence.
- `CHANGELOG.md` — new `Changed` bullet under `[Unreleased]`.

Validation: `pnpm typecheck` clean. `pnpm lint` reports the same 16 pre-existing problems as `main`. Full suite 1217 passed / 3 skipped (+2 new).