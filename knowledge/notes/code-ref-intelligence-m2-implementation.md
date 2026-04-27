---
id: k-code-intel-m2-impl
title: Code-Ref Intelligence M2 Implementation
slug: code-ref-intelligence-m2-implementation
category: implementation
tags: [code-intelligence, code-refs, cli, dashboard, events, implementation, m2]
codeRefs: [src/code-intelligence/service.ts, src/cli/code-commands.ts, src/cli/main.ts, src/dashboard/index.ts, src/orchestration/repository.ts, src/orchestration/types.ts, src/core/container.ts, public/pages/code.js, public/lib/api.js, public/lib/sidebar.js, public/app.js, knowledge/notes/monsthera-cli-command-cheatsheet.md, docs/adrs/015-code-intelligence-strategy.md, tests/unit/code-intelligence/service.test.ts, tests/unit/cli/main.test.ts, tests/unit/dashboard/dashboard.test.ts]
references: [adr-015-code-intelligence-strategy, code-ref-intelligence-mvp-implementation]
createdAt: 2026-04-27T00:00:00.000Z
updatedAt: 2026-04-27T00:00:00.000Z
---

## Summary

Shipped Milestone 2 of ADR-015 — code-ref intelligence at the CLI and
dashboard surfaces, plus a `code_high_risk_detected` orchestration event
that primes Milestone 5 (policy gating) without yet implementing it.
Builds directly on the M1 service layer
(`code-ref-intelligence-mvp-implementation`) — no new runtime dependencies,
no AST parsing.

## Added

- **CLI** in `src/cli/code-commands.ts`, wired into `src/cli/main.ts`:
  - `monsthera code ref <path>` → `service.getCodeRef`
  - `monsthera code owners <path>` → `service.findCodeOwners`
  - `monsthera code impact <path>` → `service.analyzeCodeRefImpact`
  - `monsthera code changes [--staged | --base <ref>]` → captures
    `git diff --name-only` and feeds `service.detectChangedCodeRefs`
  - JSON-only output on stdout, errors to stderr with non-zero exit
  - `--repo, -r <path>` honoured by every subcommand
- **Dashboard REST** in `src/dashboard/index.ts`:
  - `GET /api/code/ref?path=<path>` (auth-exempt by GET)
  - `GET /api/code/owners?path=<path>` (auth-exempt by GET)
  - `GET /api/code/impact?path=<path>` (auth-exempt by GET)
  - `POST /api/code/changes` body `{ changed_paths: string[] }`
    (auth-gated by mutating method)
- **Dashboard UI** in `public/pages/code.js`, registered with the SPA
  router at `/code` and the sidebar `Code` entry. Two panels: "Inspect a
  path" (single-path impact) and "Detect changes across a diff" (paste
  paths, see ranked impacts). API client helpers in `public/lib/api.js`:
  `getCodeRef`, `getCodeOwners`, `getCodeImpact`, `detectCodeChanges`.
- **Event plumbing**:
  - `code_high_risk_detected` added to `OrchestrationEventType` union,
    `VALID_ORCHESTRATION_EVENT_TYPES`, and `INTERNAL_ONLY_EVENT_TYPES`
    in `src/orchestration/repository.ts`.
  - `CodeHighRiskDetectedEventDetails` interface in
    `src/orchestration/types.ts` (path, source, reasons, counts,
    `detectedAt`).
  - Optional `eventRepo` in `CodeIntelligenceServiceDeps`;
    `src/core/container.ts` wires the production `orchestrationRepo`.
  - Emission in `analyzeCodeRefImpact` and `detectChangedCodeRefs`:
    one event per `(workId, normalizedPath)` for each active work
    article tied to a high-risk impact, deduplicated within the call.
- **Tests** (1588 passing across 115 files):
  - 5 new tests in `tests/unit/code-intelligence/service.test.ts`:
    high-risk emit, no-emit on low/medium, no-emit when no active work,
    dedup by `(workId, path)`, graceful degradation without `eventRepo`.
  - 8 new tests in `tests/unit/cli/main.test.ts` covering each
    subcommand (group help, missing arg, mutually exclusive flags,
    git-error path, unknown subcommand).
  - 7 new tests in `tests/unit/dashboard/dashboard.test.ts` covering
    each REST route (validation, 405 on wrong method, 401 on unauth
    POST, happy path).
- **Cheatsheet**: `monsthera-cli-command-cheatsheet.md` extended with a
  `code` section + quick-reference rows.

## Behaviour

### Event emission

`code_high_risk_detected` fires exactly when (a) the impact's risk is
`high` AND (b) at least one active work article is linked to the path.
The envelope's `workId` is the active work article. One event per
`(workId, normalizedPath)`, deduplicated within a single
`detectChangedCodeRefs` batch via a Set keyed on
`${workId}:${normalizedPath}`.

When the risk is high but no active work is linked (e.g. the path only
matches a policy article, or the file is missing with no work attached),
the high-risk signal still surfaces in the response payload for human
and agent consumption — but no event is emitted, because the
orchestration layer has no `workId` to address the event to. The
analysis output is still actionable; the event store just stays quiet.

`eventRepo` in `CodeIntelligenceServiceDeps` is **optional** for graceful
degradation. The container always wires it in production. Tests omit it
when they're not asserting on emission, which keeps the M1 test surface
unchanged. Emission failures are logged at `debug` and dropped — a
transient event-store error never fails an analysis read.

### `code changes` CLI

Default mode is `git diff --name-only HEAD` — captures both staged and
unstaged tracked changes. `--staged` narrows to the index (the same set
a pre-commit hook would see). `--base <ref>` covers `<ref>...HEAD` for
review-bot scenarios comparing a feature branch against `origin/main`.
Empty diff produces a zero-impact payload (`changedPathCount: 0`), not
an error — pre-commit hooks running unconditionally don't need to
special-case "no changes". Untracked files are not included; they would
need explicit handling and the M2 scope didn't justify the new flag.

The MCP tool `code_detect_changes` deliberately does NOT shell out to
git (ADR-015 *Resolved Decisions*). The CLI is the right place for that
bridge because it already runs in the operator's working tree with
their credentials.

## Naming decisions

- **CLI subcommand surface**: `monsthera code <verb> <path>`, mirroring
  `monsthera convoy <verb>` and `monsthera events <verb>`. Verbs are
  short (`ref`/`owners`/`impact`/`changes`) instead of mirroring the
  MCP tool names (`get-ref`/`find-owners`) because the CLI is for
  humans and shells; MCP names already follow the canonical
  `<domain>_<verb>` convention.
- **Event name**: `code_high_risk_detected`, following the pattern of
  `context_drift_detected` and `agent_needs_resync` — domain prefix +
  past-participle verb. Considered alternatives: `code_intelligence_high_risk_detected`
  (verbose) and `code_impact_high_risk` (awkward). The chosen name fits
  the existing event-type list at a glance and is unambiguous about
  what triggered it.

## Boundary

- M2 **emits** the event; M5 will let policies subscribe to it. The
  agent dispatcher and convoy projection are unaware of it for now —
  this is the staging step that lets M5 land without re-touching the
  service.
- The Code page is a standalone tab. The ADR's vision of "filter the
  knowledge graph by article/work/code/policy" was deliberately
  punted — extending the existing knowledge-graph page would require
  reshaping its filter model and tab semantics. Punted to a follow-up
  Milestone or to a future task that absorbs the larger graph-explorer
  redesign.
- `risk: high` on a path with no active work still surfaces in the
  response payload (so the human or agent reading it sees the signal),
  but emits no event. The orchestration loop should not have to invent
  a synthetic `workId` to track it.

## Verification

- `pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run` — all green
- `git diff --check` — clean
- Smoke-tested via the running dashboard at
  `http://localhost:4040`: the `Code` tab loads, single-path inspection
  returns the expected impact for `src/code-intelligence/service.ts`,
  and the changes panel returns ranked impacts for a 2-path diff.
- Smoke-tested CLI: `monsthera code owners src/code-intelligence/service.ts --repo /Users/xpm/Projects/Github/Monsthera`
  returns the M1 implementation note as the linked owner.
