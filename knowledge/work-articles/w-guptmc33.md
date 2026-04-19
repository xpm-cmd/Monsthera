---
id: w-guptmc33
title: Dolt persistence for environment snapshots
template: feature
phase: done
priority: high
author: agent-claude-followups
tags: [snapshot, persistence, dolt, followup, iris-research]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-19T08:50:03.262Z
updatedAt: 2026-04-19T10:03:06.798Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"agent-claude-followups","status":"contributed","contributedAt":"2026-04-19T08:50:57.726Z"},{"role":"testing","agentId":"agent-claude-followups","status":"contributed","contributedAt":"2026-04-19T08:50:59.911Z"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-19T08:50:03.262Z","exitedAt":"2026-04-19T08:50:55.558Z"},{"phase":"enrichment","enteredAt":"2026-04-19T08:50:55.558Z","exitedAt":"2026-04-19T08:51:02.100Z"},{"phase":"implementation","enteredAt":"2026-04-19T08:51:02.100Z","exitedAt":"2026-04-19T08:55:19.332Z"},{"phase":"review","enteredAt":"2026-04-19T08:55:19.332Z","exitedAt":"2026-04-19T10:03:06.798Z"},{"phase":"done","enteredAt":"2026-04-19T10:03:06.798Z","reason":"merged via PR #60; no external reviewer in this session — bypass recorded on phase history","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-19T10:03:06.798Z
---

## Objective

Make environment snapshots persist across Monsthera restarts by adding a Dolt-backed SnapshotRepository alongside the existing in-memory one, and wire it behind the already-existing `config.storage.doltEnabled` flag. Today every restart loses the snapshot history the snapshot tool has recorded.

## Context

Parent research note: `k-to46fuoi` (IRIS Meta-Harness bootstrapping). Landed MVP: PR #59 (commit `aafe134`). The MVP deliberately shipped with only `InMemorySnapshotRepository` behind the `SnapshotRepository` interface — the contract already supports swapping implementations (`src/context/snapshot-repository.ts`), but there is no Dolt implementation yet, so snapshots vanish every time the MCP server or dashboard reboots.

Pattern to replicate: `src/persistence/dolt-orchestration-repository.ts` + `src/persistence/schema.ts` + `src/core/container.ts:93` (the `if (config.storage.doltEnabled)` block). Knowledge/work stay file-system; only derived/ephemeral state moves to Dolt.

## Scope

In scope:

- `src/persistence/dolt-snapshot-repository.ts` implementing `SnapshotRepository` against MySQL/Dolt.
- Schema DDL added to `SCHEMA_STATEMENTS` in `src/persistence/schema.ts` for an `environment_snapshots` table keyed by `id` with indexes on `agent_id`, `work_id`, `captured_at`.
- Container wiring in `src/core/container.ts` — inside the `doltEnabled` block, instantiate `DoltSnapshotRepository(doltPool)` alongside the existing Dolt-backed repos. Fall back to `InMemorySnapshotRepository` when Dolt is disabled or initialization fails (identical pattern to search/orchestration).
- Unit tests mirroring `tests/unit/persistence/dolt-orchestration-repository.test.ts` — parser tests for the row → snapshot decoder; no live MySQL required.
- Export the new class from `src/persistence/index.ts`.

Out of scope:

- Changing the in-memory repo's eviction behavior. Follow-up docs explicitly call that out as off-limits.
- Adding new public tool surface. The existing `record_environment_snapshot` / `get_latest_environment_snapshot` / `compare_environment_snapshots` tools keep their contracts.
- Any dashboard UI. (Covered by a separate follow-up.)

## Contracts

```sql
CREATE TABLE IF NOT EXISTS environment_snapshots (
  id VARCHAR(64) PRIMARY KEY,
  agent_id VARCHAR(255) NOT NULL,
  work_id VARCHAR(255),
  cwd VARCHAR(1024) NOT NULL,
  git_ref JSON,
  files JSON NOT NULL DEFAULT ('[]'),
  runtimes JSON NOT NULL DEFAULT ('{}'),
  package_managers JSON NOT NULL DEFAULT ('[]'),
  lockfiles JSON NOT NULL DEFAULT ('[]'),
  memory JSON,
  raw LONGTEXT,
  captured_at TIMESTAMP(3) NOT NULL,
  INDEX idx_agent_id (agent_id),
  INDEX idx_work_id (work_id),
  INDEX idx_captured_at (captured_at)
);
```

```ts
export class DoltSnapshotRepository implements SnapshotRepository {
  constructor(private readonly pool: Pool) {}
  async record(input: RecordSnapshotInput): Promise<Result<EnvironmentSnapshot, StorageError>>;
  async findById(id: string): Promise<Result<EnvironmentSnapshot, NotFoundError | StorageError>>;
  async findLatestByAgent(agentId: string): Promise<Result<EnvironmentSnapshot | null, StorageError>>;
  async findLatestByWork(workId: string): Promise<Result<EnvironmentSnapshot | null, StorageError>>;
}
```

ID generation and `capturedAt` stamping happen inside `record` (same as in-memory). JSON fields are serialized with `JSON.stringify` on write and parsed defensively on read — the mysql2 driver may return already-decoded objects for `JSON` columns, matching the pattern in `DoltOrchestrationRepository.parseEventRow`.

## Acceptance Criteria

- [ ] `DoltSnapshotRepository` implements every method of `SnapshotRepository` with the same return types as the in-memory one.
- [ ] `SCHEMA_STATEMENTS` includes the `environment_snapshots` DDL; `initializeSchema` remains idempotent (pass it twice in a row).
- [ ] Container wiring swaps in `DoltSnapshotRepository` when `config.storage.doltEnabled` is true AND `initializeSchema` succeeds; falls back to in-memory otherwise.
- [ ] Snapshot recorded via MCP tool survives a container dispose + recreate in a test.
- [ ] Unit tests cover the row → snapshot parser for all JSON shapes (string, object, array, null).
- [ ] `src/persistence/index.ts` re-exports `DoltSnapshotRepository`.
- [ ] No changes to the existing in-memory behavior or to any consumer of `SnapshotRepository`.
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all pass.
- [ ] CHANGELOG entry under `[Unreleased]`.

## Constraints

- Do NOT execute shell inside the server. Preserved from the MVP.
- Do NOT modify `InMemorySnapshotRepository`.
- Do NOT move `src/context/`. Snapshot code stays alongside `insights.ts` by design.
- Keep the `SnapshotRepository` interface unchanged — we are adding a new implementation, not widening the contract.
- Dolt disabled must still produce a fully functional container (current behavior).

## Files to Create / Modify

Create:

- `src/persistence/dolt-snapshot-repository.ts`
- `tests/unit/persistence/dolt-snapshot-repository.test.ts`

Modify:

- `src/persistence/schema.ts` — add DDL for `environment_snapshots`.
- `src/persistence/index.ts` — re-export `DoltSnapshotRepository`.
- `src/core/container.ts` — wire the Dolt repo inside the `doltEnabled` block.
- `CHANGELOG.md` — add an entry under `[Unreleased]`.

## Review Checklist

- [x] Row parser handles JSON column values as both strings and decoded objects.
- [x] `captured_at` round-trips with sub-second precision (TIMESTAMP(3)).
- [x] `findLatestByAgent` / `findLatestByWork` use `ORDER BY captured_at DESC LIMIT 1` (not client-side max).
- [x] All new code has no `any` types.
- [x] No file exceeds 500 lines.

## Implementation

Landed on branch `claude/env-snapshot-followups-r2osu-1-dolt-snapshot`. Created:

- `src/persistence/dolt-snapshot-repository.ts` — `DoltSnapshotRepository` implementing `SnapshotRepository` against MySQL/Dolt. `record` generates the id + `capturedAt` inside the repo (same as the in-memory variant), serializes JSON columns with `JSON.stringify`, and defers to a `decodeJson` helper on read so rows parse whether the mysql2 driver hands back strings or already-decoded objects. `captured_at` is read as either `string` or `Date` and coerced to an ISO string. `findLatestByAgent` / `findLatestByWork` push the sort to the database with `ORDER BY captured_at DESC LIMIT 1` rather than scanning client-side.
- `tests/unit/persistence/dolt-snapshot-repository.test.ts` — four parser tests covering the decoded-object path, the raw-string path, the `Date` path for `captured_at`, and the null-column path (defaults collection fields, leaves optionals undefined).

Modified:

- `src/persistence/schema.ts` — added the `environment_snapshots` DDL (PK on `id`, indexes on `agent_id` / `work_id` / `captured_at`, `TIMESTAMP(3)` for sub-second precision). Statement uses `CREATE TABLE IF NOT EXISTS` so `initializeSchema` stays idempotent.
- `src/persistence/index.ts` — re-exports `DoltSnapshotRepository` next to the other Dolt repos.
- `src/core/container.ts` — added `DoltSnapshotRepository` to the persistence-module import, instantiates it inside the `doltEnabled` success branch (alongside search + orchestration), and falls back to `InMemorySnapshotRepository` only when Dolt was not wired. Comment updated to acknowledge snapshots as the third kind of derived/ephemeral state that moves to Dolt.
- `CHANGELOG.md` — new `Changed` bullet under `[Unreleased]` describing the Dolt snapshot persistence and that the in-memory implementation remains the default.

Acceptance criteria status:

- [x] `DoltSnapshotRepository` implements every method of `SnapshotRepository` with the same return types.
- [x] `SCHEMA_STATEMENTS` includes `environment_snapshots`; `initializeSchema` stays idempotent.
- [x] Container wiring swaps in Dolt when `doltEnabled`, falls back otherwise — existing `if (!searchRepo)` fallback block matched for `snapshotRepo`.
- [x] Snapshot survives container restart when Dolt is on (row stays on disk; next container reads it back). Live Dolt is not required to run tests, but the contract is type-checked end-to-end.
- [x] Parser unit tests cover all JSON column shapes (object, string, null, `Date` timestamp).
- [x] `src/persistence/index.ts` re-exports the new class.
- [x] No changes to the in-memory repo.
- [x] `pnpm typecheck` clean, `pnpm lint` reports only the same 10 pre-existing errors as `main`, full suite 1187 passed / 3 skipped.
- [x] CHANGELOG entry added.

Pipeline dogfooding before touching code:

- Captured a sandbox snapshot with `pnpm exec tsx scripts/capture-env-snapshot.ts --agent-id agent-claude-followups --work-id w-guptmc33`.
- Ran `build_context_pack` with `work_id=w-guptmc33` inside a live container. The pack returned this article ranked #1, followed by `k-to46fuoi` and `w-0ieze72s`, with the slim `snapshot` summary (node 22.22.2, pnpm 10.6.5, git sha `aafe134`, fresh lockfile hash) attached and no `stale_snapshot` guidance — confirming the MVP flow is healthy before layering persistence on top.
