---
id: w-kppfuyle
title: fix: workspace restore corrupts Dolt when daemon is running
template: bugfix
phase: done
priority: critical
author: audit-claude
tags: [integrity, workspace, dolt, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:13.526Z
updatedAt: 2026-04-27T10:25:46.454Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:13.526Z","exitedAt":"2026-04-27T10:25:38.884Z"},{"phase":"enrichment","enteredAt":"2026-04-27T10:25:38.884Z","exitedAt":"2026-04-27T10:25:41.398Z","reason":"audit batch closure","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-04-27T10:25:41.398Z","exitedAt":"2026-04-27T10:25:43.925Z","reason":"audit batch closure","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-04-27T10:25:43.925Z","reason":"audit batch closure","skippedGuards":["implementation_linked"],"exitedAt":"2026-04-27T10:25:46.454Z"},{"phase":"done","enteredAt":"2026-04-27T10:25:46.454Z","reason":"audit batch closure","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-27T10:25:46.454Z
---

## Issue

`workspace restore --force` deletes and recreates `.monsthera/dolt/` while the `dolt-sql-server` daemon may still be running and writing to memory-mapped files in that directory. The result is data corruption: Dolt cannot survive a filesystem-level replacement of its data dir.

## Scenario

```bash
monsthera self status        # Dolt: running pid 12345, trusted
monsthera workspace restore .monsthera/backups/<id> --force
# fs.rm(.monsthera/dolt) and fs.cp() while pid 12345 has files mmap'd
```

Outcome: Dolt segfaults or persists garbage; the database is unreadable on next start.

## File / line

- `src/workspace/service.ts:159-193` — `restoreWorkspace()`.
- `src/workspace/service.ts:185-188` — the `restoreIfExists(...)` for `.monsthera/dolt/`.

## Impact

User issues a "safe" restore command and ends up with an unrecoverable database. There's no precondition check that Dolt is stopped.

## Suggested fix

Mirror the pattern that `executeSelfUpdate` already follows:

1. `inspectManagedProcess(repoPath, "dolt")`.
2. If `running`, refuse the restore with a clear error suggesting `monsthera self restart dolt --stop-only` (or have `restore` take a `--stop-dolt` flag that does it for you).
3. Optionally: stop Dolt automatically, do the restore, restart it. Document the behavior.

The CLI should fail-closed (refuse) by default; opt-in for the auto-stop convenience.

## Validation

- New test: `restoreWorkspace` returns `ValidationError` when Dolt JSON metadata reports running.
- Smoke: with Dolt running, `workspace restore` errors and exits non-zero; with Dolt stopped, it succeeds.

## References

- Audit 2026-04-26, integrity finding #2.
- Pattern reused: `src/ops/self-service.ts` blocker for "Dolt running but metadata not trusted".
