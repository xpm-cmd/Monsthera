---
id: w-zuxnfk7f
title: refactor: replace throw new Error in CLI doctor commands with Result propagation
template: refactor
phase: done
priority: high
author: audit-claude
tags: [cli, result, error-handling, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:51.313Z
updatedAt: 2026-04-27T10:26:36.786Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:51.313Z","exitedAt":"2026-04-27T10:26:29.127Z"},{"phase":"enrichment","enteredAt":"2026-04-27T10:26:29.127Z","exitedAt":"2026-04-27T10:26:31.653Z","reason":"audit batch closure","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-04-27T10:26:31.653Z","exitedAt":"2026-04-27T10:26:34.261Z","reason":"audit batch closure","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-04-27T10:26:34.261Z","reason":"audit batch closure","skippedGuards":["implementation_linked"],"exitedAt":"2026-04-27T10:26:36.786Z"},{"phase":"done","enteredAt":"2026-04-27T10:26:36.786Z","reason":"audit batch closure","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-27T10:26:36.786Z
---

## Issue

Several CLI command modules throw raw `Error` instead of returning the project's `Result<T,E>` discriminated union. The stated convention (and consistent practice in domain/service code) is throws only at boundaries; CLI is *technically* a boundary but the throws short-circuit Result propagation from inner services and yield unstructured stderr instead of `formatError()` output.

## Scenario

A repo query inside `doctor-commands.ts` returns `Result.err(StorageError)`. The current code does:

```ts
if (!knowledgeResult.ok) throw new Error(`Failed: ${knowledgeResult.error.message}`);
```

The user sees a stack trace; the error code (`STORAGE_ERROR`) is lost; the JSON path (`--json`) emits malformed output.

## File / line

- `src/cli/doctor-commands.ts:82, 100, 202, 286, 291, 426` — confirmed by audit.
- Likely similar in other command modules; needs a sweep.

## Impact

Inconsistent CLI UX, broken `--json` output paths, lost structured error codes that programmatic callers (other agents, CI pipelines) rely on.

## Suggested fix

1. Sweep `src/cli/**/*.ts` for `throw new Error` and replace each with the existing pattern from `self-commands.ts`:

   ```ts
   if (!result.ok) {
     console.error(formatError(result.error));
     process.exit(1);
   }
   ```

2. Add a lint rule (custom ESLint rule or grep-based check) that flags `throw new Error` in `src/cli/`.

3. Document the convention in `docs/CODING-STANDARDS.md`.

## Validation

- `grep -rn "throw new Error" src/cli/` returns zero hits after the fix.
- All existing CLI tests still pass.
- New test: the JSON output for a failing path is well-formed JSON, not a stack trace.

## References

- Audit 2026-04-26, reliability finding #5.
