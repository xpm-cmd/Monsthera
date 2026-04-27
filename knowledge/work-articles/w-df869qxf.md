---
id: w-df869qxf
title: fix: workspace backup captures inconsistent Dolt snapshot
template: bugfix
phase: done
priority: critical
author: audit-claude
tags: [integrity, workspace, dolt, backup, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:20.434Z
updatedAt: 2026-04-27T10:25:56.538Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:20.434Z","exitedAt":"2026-04-27T10:25:48.993Z"},{"phase":"enrichment","enteredAt":"2026-04-27T10:25:48.993Z","exitedAt":"2026-04-27T10:25:51.513Z","reason":"audit batch closure","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-04-27T10:25:51.513Z","exitedAt":"2026-04-27T10:25:54.025Z","reason":"audit batch closure","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-04-27T10:25:54.025Z","reason":"audit batch closure","skippedGuards":["implementation_linked"],"exitedAt":"2026-04-27T10:25:56.538Z"},{"phase":"done","enteredAt":"2026-04-27T10:25:56.538Z","reason":"audit batch closure","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-27T10:25:56.538Z
---

## Issue

`workspace backup` calls `fs.cp(.monsthera/dolt, backupPath/dolt, { recursive: true })` without coordinating with the `dolt-sql-server` daemon. If Dolt is mid-write or has memory-mapped pages dirty, the copy captures an inconsistent snapshot and the resulting backup is unrestorable.

## Scenario

```bash
monsthera self status       # Dolt: running pid 12345
monsthera workspace backup  # silently succeeds; backup may be corrupt
```

This particularly bites because the backup APPEARS successful — `included` lists `dolt` — but the next `workspace restore` (or rollback during `self update --execute`) might restore garbage.

## File / line

- `src/workspace/service.ts:119-157` — `backupWorkspace()`.
- `src/workspace/service.ts:139` — `copyIfExists(doltDataDir, ...)`.

## Impact

Backups are silently corrupt. The new automatic rollback in `executeSelfUpdate` relies on these backups; if they're inconsistent, rollback is theatre.

## Suggested fix

Two acceptable approaches:

1. **Quiesce-by-stop** (simplest): refuse to back up while Dolt is running. If the operator wants Dolt-inclusive backups, they stop Dolt first (or the backup command does it with a `--stop-dolt` flag).
2. **Quiesce-by-flush** (better, more work): use `dolt sql -q "FLUSH TABLES; LOCK INSTANCE FOR BACKUP"` (or the closest Dolt equivalent), copy, then unlock. Requires Dolt SQL connection in the backup path.

Recommended: ship #1 first, file #2 as a follow-up. `executeSelfUpdate` already stops Dolt before the backup step in its sequence, so the unsafe path only affects standalone `workspace backup` — easy fix.

## Validation

- Test: `backupWorkspace` returns `ValidationError` when Dolt is reported running and trusted.
- Test: `executeSelfUpdate` flow continues to work because Dolt is stopped earlier in the sequence.
- Smoke: backup then restore on a quiesced workspace round-trips cleanly.

## References

- Audit 2026-04-26, integrity finding #8.
- Related: w-... (the restore counterpart).
