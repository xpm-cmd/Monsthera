---
id: w-r85lzqhv
title: Dashboard snapshot-diff endpoint and drift banner
template: feature
phase: review
priority: medium
author: agent-claude-followups
tags: [snapshot, dashboard, drift, followup, iris-research]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-19T09:13:52.190Z
updatedAt: 2026-04-19T09:21:13.065Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"agent-claude-followups","status":"contributed","contributedAt":"2026-04-19T09:14:37.826Z"},{"role":"testing","agentId":"agent-claude-followups","status":"contributed","contributedAt":"2026-04-19T09:14:41.449Z"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-19T09:13:52.190Z","exitedAt":"2026-04-19T09:14:34.331Z"},{"phase":"enrichment","enteredAt":"2026-04-19T09:14:34.331Z","exitedAt":"2026-04-19T09:14:44.960Z"},{"phase":"implementation","enteredAt":"2026-04-19T09:14:44.960Z","exitedAt":"2026-04-19T09:21:13.065Z"},{"phase":"review","enteredAt":"2026-04-19T09:21:13.065Z"}]}
---

## Objective

Give an agent resuming a work article in \`implementation\` or \`review\` a visible signal when the sandbox they are sitting in has drifted from the snapshot recorded when the article last entered that phase. Expose a GET endpoint that returns a computed diff, and add a slim banner to the expanded work card that surfaces the fields that changed.

## Context

Follow-up to PR #59 (snapshot tools) and the MVP described in research note \`k-to46fuoi\`. Today the dashboard already renders phase history but never consults the environment snapshot at all. A reviewer opening a 3-day-old work article has no way to tell — without running \`compare_environment_snapshots\` manually — that Node jumped a major version or the lockfile changed under them.

This work does NOT introduce a new mechanism for computing diffs; \`SnapshotService.compare(leftId, rightId)\` already exists (PR #59). The gap is routing the diff through an HTTP endpoint and rendering it in the UI.

## Scope

In scope:

- New route \`GET /api/work/:id/snapshot-diff?against=<snapshotId>\` in \`src/dashboard/index.ts\`. Behaviour:
  - Look up the latest snapshot for the work id (\`snapshotService.getLatest({ workId })\`); 404 shape if none exists.
  - If \`against\` is absent, use the oldest snapshot recorded against that work id as the baseline (or fall back to returning the single snapshot with \`diff: null\` — see Contracts below).
  - When both baseline and current exist, return \`{ current: EnvironmentSnapshot, baseline: EnvironmentSnapshot, diff: SnapshotDiff }\`. If no baseline is reachable (only one snapshot exists for the work), return \`{ current, baseline: null, diff: null }\`.
  - GET only. 405 otherwise. Follow the existing auth gate (no change to the gate itself).
- A helper on \`SnapshotRepository\` or \`SnapshotService\` that returns \"oldest snapshot for a work id\". The existing interface already exposes \`findLatestByWork\`; we need the symmetric \`findEarliestByWork\` or \`findAllByWork\` to pick the baseline. We will add \`findAllByWork(workId): Promise<Result<readonly EnvironmentSnapshot[], StorageError>>\` to the interface and implement it in \`InMemorySnapshotRepository\`. Ordering: oldest → newest. This also unblocks future \"timeline\" views without widening the contract again.
- UI surfacing in \`public/pages/work.js\`: when a work card is expanded AND \`article.phase ∈ {implementation, review}\`, fire the endpoint lazily (on first expand), render a small drift band with the changed-field list. Cache the response in-memory on the page state; re-fetch only on explicit refresh or card re-expand after a phase change.
- Small \`api.js\` helper \`getWorkSnapshotDiff(id, { against })\`.
- \`SnapshotService.getHistoryForWork\` or equivalent — whatever shape cleanly supports \"baseline = earliest, current = latest\".
- Tests: unit tests for the new endpoint (happy path, no-snapshot 404, single-snapshot baseline-null, explicit-against happy path, invalid id) and a repository-level test for \`findAllByWork\` ordering.

Out of scope:

- Recording a \"phase-entry snapshot\" automatically when a work article transitions. That is a bigger cross-cutting change — the baseline strategy in this PR is \"earliest snapshot for this work id\".
- Editing / selecting an explicit baseline from the UI. The \`against\` query parameter is available for callers who want to pass one, but the dashboard does not expose a picker yet.
- MCP tool surface. Agents already have \`compare_environment_snapshots\`; this work is dashboard-specific.
- Persisting the diff. Computed on demand; cheap.

## Contracts

\`\`\`ts
// new: src/context/snapshot-repository.ts
interface SnapshotRepository {
  // ...existing methods...
  findAllByWork(workId: string): Promise<Result<readonly EnvironmentSnapshot[], StorageError>>;
}

// GET /api/work/:id/snapshot-diff
// Query: against?: string
// 200:
//   {
//     current: EnvironmentSnapshot,
//     baseline: EnvironmentSnapshot | null,
//     diff: SnapshotDiff | null,
//   }
// 404 when no snapshot exists for :id.
// 404 when 'against' is provided but that id is not found.
\`\`\`

\`\`\`js
// public/lib/api.js
export function getWorkSnapshotDiff(id, { against } = {}) {
  const params = against ? \`?against=\${encodeURIComponent(against)}\` : \"\";
  return get(\`/api/work/\${encodeURIComponent(id)}/snapshot-diff\${params}\`);
}
\`\`\`

## Acceptance Criteria

- [ ] \`GET /api/work/:id/snapshot-diff\` returns current + baseline + diff when two snapshots exist for the work id.
- [ ] Returns current + \`baseline: null\` + \`diff: null\` when only one snapshot exists.
- [ ] Returns 404 when no snapshot exists at all for the work id.
- [ ] \`against=<id>\` overrides the default baseline with the specified snapshot.
- [ ] 404 when \`against\` is provided but does not resolve.
- [ ] GET only; POST/PATCH/DELETE return 405.
- [ ] Auth gate preserved (same as other \`/api/work/:id/*\` routes).
- [ ] \`findAllByWork\` returns snapshots in capture-order (oldest first). Covered by an in-memory repo test.
- [ ] Work card in phase \`implementation\` / \`review\` displays a drift band when the diff flags any change; nothing rendered otherwise.
- [ ] No changes to \`InMemorySnapshotRepository.record\` or to the MVP contract. \`findAllByWork\` is additive.
- [ ] \`pnpm typecheck && pnpm lint && pnpm test\` pass.
- [ ] CHANGELOG entry.

## Files to Create / Modify

Create:

- \`tests/unit/context/snapshot-history.test.ts\` — repo test for \`findAllByWork\`.
- \`tests/unit/dashboard/snapshot-diff-route.test.ts\` — endpoint test.

Modify:

- \`src/context/snapshot-repository.ts\` — add \`findAllByWork\` to the interface.
- \`src/context/snapshot-in-memory-repository.ts\` — implement it.
- \`src/context/snapshot-service.ts\` — expose \`getHistoryForWork\` / helper that returns \`{ current, baseline }\`.
- \`src/dashboard/index.ts\` — new route regex + handler.
- \`public/lib/api.js\` — \`getWorkSnapshotDiff\` helper.
- \`public/pages/work.js\` — drift band rendering in the expanded card.
- \`CHANGELOG.md\`

## Constraints

- MCP server does not shell out. Endpoint only computes the diff via the existing service.
- Do NOT move \`src/context/\`.
- Do NOT break \`InMemorySnapshotRepository\`'s eviction or the \`SnapshotRepository\` interface beyond the additive new method.
- Default baseline = earliest snapshot for this work id. This is a compromise; a future PR can change it to \"snapshot at phase entry\".
- UI stays tolerant of backend failures: a 404 or network error yields a silent \"no drift info\" instead of blocking the card.

## Review Checklist

- [x] `findAllByWork` sorted oldest → newest.
- [x] Endpoint 404 shape matches other `/api/work/:id/*` routes.
- [x] Drift banner renders only for `implementation` / `review` phases.
- [x] No flash of undefined diff — the UI must be fine with the endpoint still loading.
- [x] No secret values or raw probe text leaked into the slim diff shape.
- [x] No new `any` types.

## Implementation

Landed on branch `claude/env-snapshot-followups-r2osu-3-dashboard-diff`.

Pipeline dogfooding: captured a sandbox snapshot via `scripts/capture-env-snapshot.ts --agent-id agent-claude-followups --work-id w-r85lzqhv`, recorded it, and ran `build_context_pack` with `work_id=w-r85lzqhv`. The pack ranked this article #1 and attached a fresh `s-*` snapshot (stale=false) so the design-reading step was driven by the very tool this follow-up builds on top of.

Changes:

- `src/context/snapshot-repository.ts` — added `findAllByWork(workId): Promise<Result<readonly EnvironmentSnapshot[], StorageError>>` (oldest → newest) to the contract. Additive; no existing callers broken.
- `src/context/snapshot-in-memory-repository.ts` — implemented `findAllByWork` by filtering and sorting `capturedAt` ascending. Eviction behavior is untouched.
- `src/context/snapshot-service.ts` — new `getDiffForWork(workId, baselineId?)` returns `{ current, baseline, diff } | null`. Baseline default is the oldest snapshot that is not the current one. When only one snapshot exists, `baseline` and `diff` are both `null`. When `baselineId` is supplied but not found, surfaces a `NotFoundError` from the repo.
- `src/dashboard/index.ts` — new route regex `^/api/work/([^/]+)/snapshot-diff$` and handler that accepts `against` as an optional query parameter, 405s on non-GET, 404s when `getDiffForWork` returns null, and mirrors the existing error shape from `mapErrorToHttp` on repo/service errors.
- `public/lib/api.js` — `getWorkSnapshotDiff(id, { against })` helper.
- `public/pages/work.js` — expanded work card gains a `<div data-snapshot-diff>` placeholder only for phase `implementation` or `review`. A `hydrateSnapshotDrift()` pass after each `rerender()` fetches the diff lazily, caches per-work-id, and renders a small `inline-notice--warning` band listing the changed fields (runtimes, lockfiles, branch, sha, dirty, cwd, package managers) plus the age delta. Single-snapshot articles render a neutral "nothing to diff against" note; errors (404, network) silently hide the band so the rest of the card is unaffected. The cache is cleared on any mutation so the band stays honest after an advance / update.
- `tests/unit/context/snapshot-history.test.ts` — 7 tests across `InMemorySnapshotRepository.findAllByWork` (empty, ordering, scope) and `SnapshotService.getDiffForWork` (null, single-snapshot, full diff, explicit baseline, missing baseline).
- `tests/unit/dashboard/snapshot-diff-route.test.ts` — 6 integration tests through a live `startDashboard`: 404 when no snapshot, single-snapshot null-diff shape, full diff, `against` override, `against=missing-id` 404, method 405 with valid auth.
- `CHANGELOG.md` — new `Changed` bullet under `[Unreleased]`.

Acceptance criteria:

- [x] Returns `current + baseline + diff` when two+ snapshots exist for the work id.
- [x] Returns `current + null + null` when only one exists.
- [x] 404 when no snapshot exists at all.
- [x] `against=<id>` picks the explicit baseline.
- [x] `against=<missing-id>` → 404.
- [x] GET only; non-GET → 405 (with valid auth; unauthenticated POST is shadowed by the 401 auth gate, matching the existing route behavior).
- [x] Auth gate preserved by virtue of reusing the existing regex-based dispatch.
- [x] `findAllByWork` returns oldest → newest. Covered by a repo-level test.
- [x] UI renders only for `implementation` / `review` phases; other phases emit no placeholder.
- [x] No MVP contract broken. `findAllByWork` is additive.
- [x] `pnpm typecheck` clean; `pnpm lint` parity with `main` (16 pre-existing problems); `pnpm test` 1196 pass / 3 skip (+13 new).
- [x] CHANGELOG entry added.