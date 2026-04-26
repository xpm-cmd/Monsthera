---
id: w-qqzud6wf
title: fix: make Dolt → in-memory fallback opt-in instead of silent
template: bugfix
phase: planning
priority: high
author: audit-claude
tags: [reliability, container, dolt, degradation, audit-2026-04-26]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-26T11:31:35.155Z
updatedAt: 2026-04-26T11:31:35.155Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"audit-claude","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T11:31:35.155Z"}]}
---

## Issue

When `config.storage.doltEnabled = true` but Dolt is unreachable at startup, the container catches the exception and falls through to in-memory repositories. The `self status` reports it, but the boot succeeds and the user can create/index articles for an entire session that evaporate at restart.

## Scenario

1. Dolt daemon dies (OOM, port conflict, corrupt data dir).
2. User starts Monsthera; `createContainer()` tries Dolt, fails, falls back to in-memory.
3. User works for hours, creates knowledge articles, advances work items.
4. Restart → all session work lost; only Markdown files (which the in-memory repo did write) remain.

The current degradation is "best-effort" but communicated only via a status flag that nobody reads.

## File / line

- `src/core/container.ts:107-186` — Dolt initialization branch.
- `src/core/container.ts:189-208` — in-memory fallback construction.

## Impact

Silent data loss across restarts; users discover the regression by accident. A degradation-by-default for a stateful tool that stores derived data.

## Suggested fix

Make the fallback opt-in:

1. Default `doltEnabled=true` should fail-closed at startup with a clear error pointing at `self doctor` and `self restart dolt`.
2. New flag `--allow-degraded` (or env `MONSTHERA_ALLOW_DEGRADED=1`) explicitly opts in to in-memory fallback for emergency read-only use.
3. When degraded, prepend a banner to every CLI output: `WARN: running in degraded in-memory mode; mutations will not persist.`

This is consistent with the `self update --execute` philosophy of explicit blockers and explicit opt-ins.

## Validation

- Test: `createContainer({ doltEnabled: true })` against an unreachable Dolt returns `Result.err`, not a degraded container.
- Test: with `allowDegraded: true`, returns container + a `degraded: true` flag.
- Smoke: stop Dolt, run `monsthera knowledge create` → fails fast; run with `--allow-degraded` → warns and uses in-memory.

## References

- Audit 2026-04-26, reliability finding #4.
- Memory: `decision:batch-4-fase-9-audit-2026-04-18` documented the current degradation as "shipped as designed". This work article reverses that decision based on real-world data-loss risk.
