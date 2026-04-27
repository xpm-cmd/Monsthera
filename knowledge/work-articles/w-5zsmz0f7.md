---
id: w-5zsmz0f7
title: fix: knowledge create slug TOCTOU loses articles on parallel create
template: bugfix
phase: done
priority: high
author: audit-claude
tags: [concurrency, knowledge, toctou, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:41.965Z
updatedAt: 2026-04-27T10:26:26.609Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:41.965Z","exitedAt":"2026-04-27T10:26:19.103Z"},{"phase":"enrichment","enteredAt":"2026-04-27T10:26:19.103Z","exitedAt":"2026-04-27T10:26:21.603Z","reason":"audit batch closure","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-04-27T10:26:21.603Z","exitedAt":"2026-04-27T10:26:24.110Z","reason":"audit batch closure","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-04-27T10:26:24.110Z","reason":"audit batch closure","skippedGuards":["implementation_linked"],"exitedAt":"2026-04-27T10:26:26.609Z"},{"phase":"done","enteredAt":"2026-04-27T10:26:26.609Z","reason":"audit batch closure","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-27T10:26:26.609Z
---

## Issue

`FileSystemKnowledgeArticleRepository.create()` checks slug uniqueness with `loadAll()` then writes the new file. Two concurrent `create` calls with the same slug both pass the check and the second write silently overwrites the first (or the file is corrupted by interleaved writes if the OS happens to schedule them concurrently).

## Scenario

```
Agent A: knowledge create --slug auth-policy  → loadAll(), slug free, writeFile
Agent B: knowledge create --slug auth-policy  → loadAll() before A writes, slug free, writeFile
Result: one of the two articles is destroyed; no error reported.
```

## File / line

- `src/knowledge/file-repository.ts:170-197` — `create()`.
- Lines 171-174: the slug check that races with the write.

## Impact

Silent article loss on the (admittedly rare) burst-create case. Bad enough that an automated agent that generates slugs deterministically can lose an entire work item.

## Suggested fix

Combine with the file-locking work from w-... (lost-update fix). Specifically:

1. Acquire a directory-level lock on `knowledge/notes/` (or wherever the category lives) before the `loadAll`.
2. Or: write to a temp path and use `fs.rename` with `O_EXCL` semantics — atomic create-if-not-exists.

The `O_EXCL` approach is simpler and doesn't require a lock library:

```ts
import { open } from "node:fs/promises";
const handle = await open(filePath, "wx"); // fails if file exists
await handle.writeFile(content, "utf-8");
await handle.close();
```

If the lock-file work lands first, the locking version is acceptable too.

## Validation

- Test: 20 parallel `create` calls with the same slug → exactly one succeeds, others return `AlreadyExistsError`.
- Test: 20 parallel `create` calls with unique slugs → all succeed, no file corruption.

## References

- Audit 2026-04-26, concurrency finding #3.
- Related: w-... (lost-update / file-repo races).
