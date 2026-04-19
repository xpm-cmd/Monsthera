# ADR-006: Opt-in `snapshot_ready` Guard for `enrichment → implementation`

**Status:** Accepted
**Date:** 2026-04-19
**Decision makers:** Architecture team

## Context

PR #59 added three MCP tools (`record_environment_snapshot`, `get_latest_environment_snapshot`, `compare_environment_snapshots`) plus `build_context_pack` integration, closing the semantic vs. physical context gap identified in research note `k-to46fuoi` (IRIS Meta-Harness bootstrapping). Snapshots are now recorded and surfaced, but they do not yet gate any transition — a reviewer can still advance a work article to `implementation` on a sandbox with drifted lockfiles or no snapshot at all.

The existing guard layer (`src/work/guards.ts`, `src/work/lifecycle.ts`) consists of pure functions of `WorkArticle`. It has no dependency on any service and runs synchronously inside `checkTransition`. Teaching the current system about physical sandbox state means introducing an asynchronous guard with service dependencies — touching the guard model for the first time since Tier 2.1.

## Decision

Add a single async guard, `snapshot_ready`, that only fires on `enrichment → implementation`, and only when the template explicitly opts in. Keep the existing sync guard machinery unchanged; async guards run after the sync set as a second, separate pass.

### Shape

- `src/work/guards.ts` gains `snapshot_ready(article, deps): Promise<boolean>`. Rules:
  - A recorded snapshot exists for `workId`.
  - The snapshot is not flagged `stale` by `SnapshotService` (controlled by `MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES`, default 30 min; `0` disables the freshness check).
  - Every HEAD lockfile hash pre-computed by the caller matches the snapshot. Missing entries fail closed.
- `src/work/lifecycle.ts` gains `AsyncGuardEntry`, `GuardDeps`, `getAsyncGuardSet`, and `evaluateAsyncGuards`. `checkTransition` is unchanged; repositories call both evaluators and concatenate the `skippedGuards`.
- `WorkTemplateConfig.requiresSnapshotForImplementation?: boolean` is the opt-in flag. Only `FEATURE` is set to `true`. `BUGFIX`, `REFACTOR`, `SPIKE` stay `false`.
- `AdvancePhaseOptions.guardDeps` carries per-call deps (`snapshotService` + pre-hashed HEAD lockfiles). The `WorkService` computes these once per advance when the template opts in; repo stays stateless.

### Why opt-in

Bugfix, refactor, and spike flows often run in environments without a captured snapshot — quick bugs fixed in a REPL, a refactor staged on a branch, a spike done on a colleague's laptop. Forcing a snapshot on those templates adds ceremony without adding safety: the bug and the refactor have narrower blast radius than a feature, and the spike is research that does not produce production code at all. Only `FEATURE` articles — the ones that ship meaningful code — warrant the extra check.

### Why fail-closed on missing deps

`evaluateAsyncGuards` needs a `snapshotService`. If the caller does not supply one (unit tests, direct repository usage, harness scripts without snapshot wiring), we could either fail the guard or skip it. We chose to skip it: the MVP shipped with this behavior (no guard enforcement at all), and the guard is additive — silently dropping it matches the status quo rather than surprising callers who predate the feature. Production wires the service in the container, so the guard always fires there.

The guard itself still fails closed inside `snapshot_ready` once the service is present: no recorded snapshot, stale snapshot, missing lockfile entry, or mismatched hash all return `false`.

### Interaction with `skipGuard`

`skipGuard: { reason }` bypasses the new guard the same way it bypasses every existing guard. The bypassed name (`"snapshot_ready"`) appears in `phaseHistory[].skippedGuards` and the reason on `phaseHistory[].reason`, so an auditor can tell when an agent pushed past a drifted sandbox and why. No new escape hatch is introduced.

## Consequences

### Positive

- Feature articles cannot silently advance to `implementation` on a drifted sandbox. Running `scripts/capture-env-snapshot.ts` + `record_environment_snapshot` becomes a required step for feature flow, enforced by the guard rather than by convention.
- The async guard slot is reusable. Future guards that need to consult services (e.g. "CI green on HEAD", "migration applied") slot into `getAsyncGuardSet` without touching the sync path.
- The opt-in template flag is discoverable: a template author flipping `requiresSnapshotForImplementation: true` immediately gates the transition.
- `skipGuard` audit trail covers the new guard for free.

### Negative

- Two guard evaluators (sync + async) instead of one. Engineers adding a guard now choose the right bucket; there is a small risk of async work sneaking into the sync path.
- Lockfile hashing on every feature `enrichment → implementation` advance touches disk once. Negligible in practice (small files, cached by the OS) but measurable on slow FSes.
- The `snapshotService` is now a dependency of the async guard surface. Tests that want to exercise the guard must wire it; tests that do not wire it see the MVP behavior.

### Neutral

- The sync guard contract is unchanged. Existing tests and callers work without modification.
- The `readHeadLockfileHashes` helper uses `node:crypto` + `node:fs` — no subprocess, consistent with the "MCP server never shells out" rule that the MVP preserved.

## Implementation Notes

- Async guard set lives next to the sync one in `src/work/lifecycle.ts`. Both return immutable arrays so `checkTransition` / `evaluateAsyncGuards` stay pure dispatch.
- `WorkService.enrichOptionsWithGuardDeps` computes the guard deps before delegating to the repo. Only fires on `enrichment → implementation` for opted-in templates.
- `DEFAULT_LOCKFILE_PATHS` in `src/work/lockfile-hashes.ts` is a conservative allowlist (`pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `uv.lock`, `poetry.lock`, `Cargo.lock`, `go.sum`). Missing files are skipped, not errored.

## References

- Research note: `knowledge/notes/iris-meta-harness-environment-bootstrapping-and-implications-for-monsthera.md` (`k-to46fuoi`)
- Parent work article (MVP): `w-0ieze72s` — PR #59 / commit `aafe134`
- This work article: `w-y988ky96`
- Prior ADR on guards: the Tier 2.1 feature branch — `src/work/lifecycle.ts` `checkTransition` + `skipGuard`.
