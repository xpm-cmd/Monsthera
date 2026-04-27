---
id: w-8qeo1wwj
title: fix: process command validation by substring is spoofable
template: bugfix
phase: done
priority: high
author: audit-claude
tags: [security, process-registry, trust, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:58.372Z
updatedAt: 2026-04-27T10:26:47.066Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:58.372Z","exitedAt":"2026-04-27T10:26:39.398Z"},{"phase":"enrichment","enteredAt":"2026-04-27T10:26:39.398Z","exitedAt":"2026-04-27T10:26:42.032Z","reason":"audit batch closure","skippedGuards":["has_objective","has_acceptance_criteria"]},{"phase":"implementation","enteredAt":"2026-04-27T10:26:42.032Z","exitedAt":"2026-04-27T10:26:44.555Z","reason":"audit batch closure","skippedGuards":["min_enrichment_met"]},{"phase":"review","enteredAt":"2026-04-27T10:26:44.555Z","reason":"audit batch closure","skippedGuards":["implementation_linked"],"exitedAt":"2026-04-27T10:26:47.066Z"},{"phase":"done","enteredAt":"2026-04-27T10:26:47.066Z","reason":"audit batch closure","skippedGuards":["all_reviewers_approved"]}]}
completedAt: 2026-04-27T10:26:47.066Z
---

## Issue

`validateProcessCommand()` matches a managed process's actual command against the metadata using `String.prototype.includes()` (substring) and a basename fallback. This is trivially spoofable: any process on the system whose `ps` output happens to include the basename `dolt` (or whatever string the metadata stored) passes validation.

## Scenario

1. Attacker writes a malicious `.monsthera/run/dolt.json` with `pid: <attacker-pid>` and `command: ["dolt"]`.
2. The attacker spawns `/tmp/dolt-fake-script` (a shell script named `dolt`) and ensures the basename matches.
3. `validateProcessCommand` matches by basename → trusted.
4. `stopManagedProcess --force` would then kill the attacker's process — actually fine — but more importantly, the trust signal lies elsewhere: any tool relying on `trusted=true` to make policy decisions has been fooled.

## File / line

- `src/ops/process-registry.ts:275-286` — `validateProcessCommand()`.
- Line 285: `actual.includes(expected) || actual.includes(executable)`.

## Impact

Medium. Practical exploitation requires write access to `.monsthera/run/`, which means the attacker is already inside the user's home dir. But the trust signal is foundational for `self update --execute`'s "Dolt running but not trusted" blocker; weakening it weakens the whole self-update guard.

## Suggested fix

Validate by absolute path, not substring:

```ts
const { stdout } = await execFile("ps", ["-p", String(pid), "-o", "comm="], ...);
const actualBin = stdout.trim();
const expectedBin = path.basename(metadata.command[0] ?? "");
return ok(actualBin === expectedBin);
```

Even stronger: read `/proc/<pid>/exe` (Linux) or `lsof -p <pid>` (macOS) and compare the absolute executable path.

## Validation

- Test: metadata with `command: ["dolt"]` and an actual `ps` output of `/usr/local/bin/notdolt.sh` → `trusted: false`.
- Test: metadata with `command: ["/path/to/dolt"]` and `ps` showing `/path/to/dolt` → `trusted: true`.

## References

- Audit 2026-04-26, security finding #3.
- ADR-014 / ADR-015 reference this trust check as a foundation of self-update safety.
