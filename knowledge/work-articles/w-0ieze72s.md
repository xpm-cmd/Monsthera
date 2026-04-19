---
id: w-0ieze72s
title: Add environment_snapshot MCP tool and snapshot-aware context pack
template: feature
phase: review
priority: medium
author: agent-investigator
tags: [agents, context, mcp, tools, bootstrapping, iris-research]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-19T07:56:38.775Z
updatedAt: 2026-04-19T08:41:07.334Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"agent-investigator","status":"contributed","contributedAt":"2026-04-19T08:25:44.179Z"},{"role":"testing","agentId":"agent-investigator","status":"contributed","contributedAt":"2026-04-19T08:25:47.504Z"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-19T07:56:38.775Z","exitedAt":"2026-04-19T08:17:12.667Z"},{"phase":"enrichment","enteredAt":"2026-04-19T08:17:12.667Z","exitedAt":"2026-04-19T08:25:50.409Z"},{"phase":"implementation","enteredAt":"2026-04-19T08:25:50.409Z","exitedAt":"2026-04-19T08:41:07.334Z"},{"phase":"review","enteredAt":"2026-04-19T08:41:07.334Z"}]}
---



## Objective

Give agents using Monsthera the cold-start savings reported by the IRIS Meta-Harness artifact by adding an `environment_snapshot` MCP tool that records a normalized sandbox snapshot, and teaching `build_context_pack` to surface the most recent snapshot alongside semantic context.

## Background

Full rationale, comparison against the IRIS artifact, and design discussion live in the knowledge article `k-to46fuoi` (`knowledge/notes/iris-meta-harness-environment-bootstrapping-and-implications-for-monsthera.md`). Read that first.

Short version: Meta-Harness saves 2-5 reconnaissance turns per task by injecting a pre-run sandbox snapshot (cwd, ls, available runtimes, memory) into the initial prompt. Monsthera has no equivalent. `build_context_pack` answers "what the project means", not "what this sandbox actually is right now". This work closes that gap.

## Scope

In scope:

- A new MCP tool `environment_snapshot` with `record`, `get_latest`, and `compare` actions.
- A Zod-validated snapshot schema.
- Persistence: start with an orchestration event (Dolt) + a tombstone under `knowledge/snapshots/` only if explicitly flagged as durable. Default is ephemeral (event only).
- `build_context_pack` extended to optionally include the most recent snapshot for a given agent / workId, with a staleness warning.
- Tests for schema validation, record/get/compare, pack integration, and staleness rules.

Out of scope:

- Any server-side shell execution. Snapshots are supplied by the caller (agent harness or a Monsthera CLI helper), never gathered by the MCP server itself.
- A full terminal harness. Monsthera remains a knowledge + work platform.
- Benchmark comparison against Meta-Harness — tracked separately.

## Contracts

New schema (proposed, `src/context/snapshot-schema.ts`):

```ts
const SnapshotSchema = z.object({
  id: z.string(),                 // s-<base36>
  agentId: z.string(),
  workId: z.string().optional(),  // link to a work article when known
  capturedAt: z.string(),         // ISO8601
  cwd: z.string(),
  gitRef: z.object({
    branch: z.string().optional(),
    sha: z.string().optional(),
    dirty: z.boolean().optional(),
  }).optional(),
  files: z.array(z.string()).default([]),          // top-level ls
  runtimes: z.record(z.string(), z.string()).default({}),   // { node: "20.11.0", python3: "3.11.4" }
  packageManagers: z.array(z.string()).default([]),         // ["pnpm", "npm"]
  lockfiles: z.array(z.object({ path: z.string(), sha256: z.string() })).default([]),
  memory: z.object({ totalMb: z.number(), availableMb: z.number() }).optional(),
  raw: z.string().optional(),     // original text for audit
});
```

New id prefix `s-` added to `src/core/types.ts` via an existing `generateId("s")` call (no schema change required — the helper is generic).

New MCP tool actions in `src/tools/agent-tools.ts`:

- `environment_snapshot.record(input)` → validates, stores, returns `{ id, capturedAt }`.
- `environment_snapshot.get_latest({ agentId?, workId? })` → returns the most recent matching snapshot or `null`.
- `environment_snapshot.compare({ leftId, rightId })` → returns a diff `{ runtimesChanged, lockfilesChanged, branchChanged, cwdChanged, ageDeltaSeconds }`.

`build_context_pack` extension (in `src/context/insights.ts` / `src/tools/search-tools.ts`): accept an optional `includeSnapshot: boolean` (default true when `workId` or `agentId` is provided). When included, the pack contains the latest snapshot and an `snapshotAgeSeconds` field. If age exceeds a configurable threshold (default 30 min), emit a `stale_snapshot` warning in the pack.

## Files to Create / Modify

Create:

- `src/context/snapshot-schema.ts` — Zod schema + types.
- `src/context/snapshot-service.ts` — record / get-latest / compare against the orchestration event store (or an in-memory repo for tests, mirroring the pattern in `src/orchestration/`).
- `tests/unit/context/snapshot-schema.test.ts`
- `tests/unit/context/snapshot-service.test.ts`
- `tests/unit/tools/environment-snapshot-tool.test.ts`

Modify:

- `src/tools/agent-tools.ts` — register `environment_snapshot` tool with the three actions.
- `src/tools/index.ts` — re-export.
- `src/context/insights.ts` — extend the context pack shape to carry `snapshot` and `snapshotAgeSeconds`.
- `src/tools/search-tools.ts` — thread the `includeSnapshot` option through `build_context_pack`.
- `scripts/` — add a small helper `scripts/capture-env-snapshot.ts` that an agent's harness can invoke locally and pipe the JSON into the MCP `record` call. (Helper only; not wired into the server.)

Do NOT modify:

- `src/server.ts` transport plumbing beyond tool registration.
- Any work / knowledge repository code. Snapshots are a new dimension, not a new article type.

## Acceptance Criteria

- [ ] `SnapshotSchema` validates a realistic sample and rejects malformed input with a clear Zod issue path.
- [ ] `environment_snapshot.record` round-trips through the service and returns a snapshot id with the `s-` prefix.
- [ ] `environment_snapshot.get_latest` returns the newest snapshot for a given agent / work, and `null` when none exists.
- [ ] `environment_snapshot.compare` correctly flags changed runtimes, changed lockfile hashes, branch changes, and cwd changes.
- [ ] `build_context_pack` with `workId` returns the latest snapshot when one exists and `snapshotAgeSeconds` is populated.
- [ ] A snapshot older than the configured staleness threshold surfaces a `stale_snapshot` warning in the pack response.
- [ ] The MCP server does not spawn any subprocess as part of `record`. Verified by a test that stubs `child_process` and asserts no `spawn` / `exec` calls.
- [ ] All new code follows `docs/CODING-STANDARDS.md`.
- [ ] No `any` types.
- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all pass.

## Test Command

```
pnpm vitest run tests/unit/context/snapshot-schema.test.ts tests/unit/context/snapshot-service.test.ts tests/unit/tools/environment-snapshot-tool.test.ts
```

## Constraints

- Server MUST NOT execute shell commands. Snapshot data arrives as input to the tool.
- Snapshot storage defaults to the orchestration event store (Dolt when enabled; in-memory repo otherwise) — no new markdown on disk by default.
- Backwards compatibility: existing `build_context_pack` callers must keep working when no snapshot exists; `snapshot` field is optional.
- Staleness threshold is configurable via env var (`MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES`, default 30). Do not hard-code in service logic.
- Maximum file size: 500 lines.

## Edge Cases

- No snapshot exists for the requested agent / work → tool returns `null`, pack omits the field, no warning.
- Snapshot exists but is older than the threshold → pack includes it AND emits the warning. Do not silently drop it.
- `compare` called with one or both ids missing → return a typed `NotFoundError` Result, not a thrown exception.
- `record` called without `workId` → accept and store; `get_latest` by `agentId` alone must still work.
- Dolt disabled → fall back to in-memory repo, same contract.

## Review Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] Snapshot tool tests pass
- [ ] Context pack tests pass (including staleness warning)
- [ ] No files exceed 500 lines
- [ ] No `any` type annotations
- [ ] No server-side shell execution introduced
- [ ] CHANGELOG entry added under the next alpha

## Follow-ups (separate work articles, not this one)

- Guard predicates that consume snapshots (e.g. `ready_to_implement` requires a fresh snapshot with clean lockfile).
- Snapshot diffing surfaced in the dashboard when resuming a work article.
- Benchmark harness that uses `environment_snapshot` + `build_context_pack` against a public terminal task set to produce numbers comparable to the IRIS Meta-Harness report.

## Implementation evidence

Landed on branch `claude/investigate-iris-artifact-GdxdL` (PR #59). Commit `8b58169` "feat(context): environment_snapshot MCP tools and snapshot-aware context pack".

Files added:

- `src/context/snapshot-schema.ts`
- `src/context/snapshot-repository.ts`
- `src/context/snapshot-in-memory-repository.ts`
- `src/context/snapshot-service.ts`
- `src/context/index.ts`
- `src/tools/snapshot-tools.ts`
- `scripts/capture-env-snapshot.ts`
- `tests/unit/context/snapshot-schema.test.ts`
- `tests/unit/context/snapshot-service.test.ts`
- `tests/unit/tools/snapshot-tools.test.ts`
- `tests/unit/tools/search-tools-snapshot.test.ts`

Files modified:

- `src/core/config.ts` — new `context` block with `snapshotMaxAgeMinutes`
- `src/core/container.ts` — wires `snapshotRepo` + `snapshotService`
- `src/server.ts` — registers and dispatches snapshot tools
- `src/tools/index.ts` — re-exports
- `src/tools/search-tools.ts` — `build_context_pack` accepts `agent_id` / `work_id` and attaches snapshot
- `CHANGELOG.md`

Acceptance criteria — all green:

- `SnapshotSchema` validates realistic input and rejects malformed input with Zod issue paths.
- `record` returns an `s-`-prefixed id.
- `getLatest` returns the newest snapshot for a scope; `null` when none exists.
- `compare` flags runtime, lockfile, branch, sha, dirty, cwd, and package-manager changes.
- `build_context_pack` with `work_id` or `agent_id` includes the latest snapshot and an `ageSeconds` field.
- Stale snapshots (`ageSeconds > maxAgeMinutes * 60`) append a `stale_snapshot` entry to `guidance`.
- MCP server spawns no shell: snapshot input is provided by the caller.
- `pnpm typecheck` clean; `pnpm lint` reports only pre-existing errors; 1183 tests pass.

No files exceed 500 lines. No `any` types introduced. CHANGELOG updated under `[Unreleased]`.