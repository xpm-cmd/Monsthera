# ADR-016: Self update rollback and doctor

## Status

Accepted — 2026-04-26

## Context

ADR-014 introduced `monsthera self update --execute`: a guarded sequence
that backs up the workspace, stops managed Dolt, fast-forwards git, builds,
migrates, reindexes, and restarts Dolt. The first slice protected the user
*before* the update by refusing to run when blockers were present, but it
did nothing useful *after* a step failed mid-execution.

Concretely, if `pnpm build` failed:

- The workspace backup remained as an untouched artifact under
  `.monsthera/backups/`.
- Managed Dolt was already stopped and would not be restarted.
- The install checkout was left at the new HEAD, possibly with broken
  dependencies, with no automated way back.

Operators were expected to read the ad-hoc error message, locate the
backup, run `workspace restore --force`, and restart Dolt by hand. That
expectation was undocumented, error-prone, and meant a partial update could
silently leave the user with a broken install and a healthy-looking
workspace they did not realise had drifted.

A second gap surfaced from the same code path: the in-process command
runner (`runCommand`, `git`) was a private module-local helper, so there
was no way to write tests for the update path without invoking real
`git pull`, `pnpm install`, and `pnpm build`. The single existing test
covered the "blocker refusal" branch only.

A third gap was diagnostic. `self status` reported state but did not
explain *why* the state was wrong, and there was no operation to clean up
known recoverable conditions (legacy `.pid` files, stale process
metadata).

## Decision

Three coordinated changes:

1. **Inject a `CommandRunner` so update steps are testable.** A new
   `src/ops/command-runner.ts` defines a `CommandRunner` interface and a
   `realCommandRunner`. `inspectSelf`, `planSelfUpdate`, `restartDolt`, and
   `executeSelfUpdate` accept an optional runner. Production code uses the
   real runner; tests inject a deterministic one that returns scripted
   stdout/stderr or simulated failures.

2. **Automatic rollback on `self update --execute`.** If any step after
   the workspace backup fails, the executor restores the workspace from
   the backup with `restoreWorkspace(..., force: true)` and, when Dolt was
   running before the update, attempts to restart it. The failure is
   reported as a `StorageError` whose `details.rollback` field carries the
   structured rollback report (`{ performed, backupPath, restored,
   skipped, doltRestarted, errors }`). The rollback intentionally does
   **not** rewind `git pull` — the user's data is the protected asset, and
   forcefully resetting the install checkout could destroy in-progress
   work outside the merge.

3. **`monsthera self doctor`.** A new diagnostic command in
   `src/ops/doctor.ts` that classifies findings as `blocker`, `warning`,
   or `info`, and supports `--fix` for the recoverable ones:

   - Missing workspace manifest → `workspace migrate`.
   - Legacy `<kind>.pid` pointing at a live process → adopt into trusted
     JSON metadata via `adoptLegacyPidFile`.
   - Stale JSON metadata for a dead process → remove via
     `cleanupStaleMetadata`.

   Untrusted-but-running processes and dirty installs are reported as
   blockers without auto-fix because they require operator judgment.

## Consequences

- `executeSelfUpdate` always either succeeds, returns a blocker error
  before changing anything, or returns an error with a workspace already
  restored to its pre-update state. Operators no longer need to know how
  to invoke `workspace restore` manually after a failed update.
- The runner abstraction adds testability without changing the production
  command behaviour. Tests for the rollback path no longer require git or
  pnpm.
- `self doctor` consolidates institutional knowledge about recoverable
  failure states into a single command. Legacy `.pid` files, which are
  still emitted by `start-local.sh` for backwards compatibility, can now
  be promoted to trusted JSON metadata without restarting Dolt.
- Rollback does not restore the install checkout. Users who hit a
  `pnpm build` regression on a newer commit may need to `git reset --hard
  ORIG_HEAD` manually. This is documented in
  `docs/self-update-runbook.md`.
- The runbook (`docs/self-update-runbook.md`) becomes the canonical
  user-facing companion to this ADR.
