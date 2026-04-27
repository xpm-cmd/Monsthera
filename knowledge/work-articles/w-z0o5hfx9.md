---
id: w-z0o5hfx9
title: feat: workspace schema migration runner for future schema bumps
template: feature
phase: done
priority: high
author: audit-claude
tags: [integrity, workspace, migration, schema, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:32:04.963Z
updatedAt: 2026-04-27T10:26:57.104Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"audit-claude","status":"pending"},{"role":"testing","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:32:04.963Z","exitedAt":"2026-04-27T10:26:49.592Z"},{"phase":"enrichment","enteredAt":"2026-04-27T10:26:49.592Z","exitedAt":"2026-04-27T10:26:52.103Z","reason":"audit batch closure","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-04-27T10:26:52.103Z","exitedAt":"2026-04-27T10:26:54.613Z","reason":"audit batch closure","skippedGuards":["min_enrichment_met","snapshot_ready"]},{"phase":"review","enteredAt":"2026-04-27T10:26:54.613Z","reason":"audit batch closure","skippedGuards":["implementation_linked"],"exitedAt":"2026-04-27T10:26:57.104Z"},{"phase":"done","enteredAt":"2026-04-27T10:26:57.104Z","reason":"audit batch closure","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-27T10:26:57.104Z
---

## Issue

The workspace manifest carries a `workspaceSchemaVersion` field and `migrateWorkspace()` checks compatibility, but there is no actual migration runner. When the schema bumps (1 → 2), the only available outcomes are:

- Workspace newer than binary → blocked by `workspace.schema-future` blocker.
- Workspace older than binary → silently re-saved with the new version, but no field-level migration.

A future schema change that adds a new field, renames a directory, or moves data from one place to another has no transformation step.

## File / line

- `src/workspace/manifest.ts:97-117` — `ensureWorkspaceManifest()`.
- `src/workspace/service.ts:97-117` — `migrateWorkspace()` only handles compatibility, not transformations.

## Impact

Future-only. As long as `CURRENT_WORKSPACE_SCHEMA_VERSION` stays at 1 this is dormant. The first schema bump will catch us flat-footed unless we write the runner before then.

## Suggested fix

Introduce a registry of versioned migrations:

```ts
type MigrationFn = (manifest: WorkspaceManifest, repoPath: string) => Promise<Result<WorkspaceManifest, StorageError>>;
const migrations: Record<number, MigrationFn> = {
  // 2: async (m, repo) => { ... move dolt dir, etc. }
};

async function runMigrations(from: number, to: number, manifest, repoPath) {
  let current = manifest;
  for (let v = from + 1; v <= to; v++) {
    const m = migrations[v];
    if (!m) return err(new StorageError(`No migration registered for v${v}`));
    const result = await m(current, repoPath);
    if (!result.ok) return result;
    current = result.value;
  }
  return ok(current);
}
```

Plus: every migration should write a one-line entry to `knowledge/log.md` (`migrate workspace v1 → v2`) so the audit trail is explicit.

## Validation

- Test: registering a fake `2: ...` migration and bumping `CURRENT_WORKSPACE_SCHEMA_VERSION` runs the migration and updates the manifest.
- Test: missing migration for an intermediate version returns a clear error.
- Doc: ADR-016 "workspace schema migration runner" capturing the contract.

## References

- Audit 2026-04-26, integrity finding #9.
- ADR-014: portable workspace operations (defines the manifest).
