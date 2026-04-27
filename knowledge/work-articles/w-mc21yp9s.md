---
id: w-mc21yp9s
title: refactor: lock file-repository read-modify-write to prevent lost updates
template: refactor
phase: done
priority: critical
author: audit-claude
tags: [concurrency, file-repository, locking, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:27.216Z
updatedAt: 2026-04-27T10:26:06.565Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:27.216Z","exitedAt":"2026-04-27T10:25:59.054Z"},{"phase":"enrichment","enteredAt":"2026-04-27T10:25:59.054Z","exitedAt":"2026-04-27T10:26:01.560Z","reason":"audit batch closure","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-04-27T10:26:01.560Z","exitedAt":"2026-04-27T10:26:04.059Z","reason":"audit batch closure","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-04-27T10:26:04.059Z","reason":"audit batch closure","skippedGuards":["implementation_linked"],"exitedAt":"2026-04-27T10:26:06.565Z"},{"phase":"done","enteredAt":"2026-04-27T10:26:06.565Z","reason":"audit batch closure","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-27T10:26:06.565Z
---

## Issue

`FileSystemKnowledgeArticleRepository.update` and `FileSystemWorkArticleRepository.update`/`advancePhase` follow a read-modify-write pattern (`findById` → modify → `writeFile`) without any locking. Two concurrent updates from parallel agents — exactly the scenario Monsthera is designed to coordinate — produce a lost-update silently.

## Scenario

```
Agent A: work advance w-foo planning→enrichment   (reads, computes phase history)
Agent B: work update  w-foo --content ...         (reads, modifies content)
Both write back. Whoever writes last wins.
```

Same pattern in `create` (slug uniqueness check is a TOCTOU between `loadAll()` and `writeFile`) and in cross-article cleanup (delete that scans dependencies vs concurrent create with new dependency).

## File / line

- `src/knowledge/file-repository.ts:170-197` — `create()` slug TOCTOU.
- `src/knowledge/file-repository.ts:204-239` — `update()` lost-update.
- `src/work/file-repository.ts:292-312` — `update()` lost-update.
- `src/work/file-repository.ts:382-441` — `advancePhase()` interleaving.
- `src/work/file-repository.ts:315-341` — `delete()` dependency cleanup race with concurrent create.

## Impact

In multi-agent deployments (the product's primary use case), agents lose work silently. Phase history disappears, enrichment contributions revert, IDs collide on bursty creates. No detection, no log entry, no test catches it.

## Suggested fix

Per-article advisory file lock with `proper-lockfile` (already battle-tested) on the article path:

```ts
import { lock } from "proper-lockfile";

async function withArticleLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const release = await lock(filePath, { retries: { retries: 5, factor: 2, minTimeout: 50, maxTimeout: 500 } });
  try { return await fn(); } finally { await release(); }
}
```

Wrap every read-modify-write in repos. For `create`, lock at the slug/dir granularity. For cross-article ops (delete cleanup), use a coarser repo-level lock or move the invariant into Dolt with `executeTransaction()`.

Long-term: migrate mutating paths to Dolt-backed repos and use `executeTransaction()` (which already exists at `src/persistence/connection.ts`). File repos stay as a fallback, locked.

## Validation

- New tests in `tests/unit/knowledge/file-repository-races.test.ts` exercising 50 parallel updates and asserting all complete without lost writes.
- Same for work repository covering `update`, `advancePhase`, `contributeEnrichment`.
- Soak test (10s) running in CI.

## References

- Audit 2026-04-26, concurrency findings #1-#5.
- ADR-???: file-locking strategy (to be written as part of this work).
