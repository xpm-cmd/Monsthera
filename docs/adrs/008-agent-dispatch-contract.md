# ADR-008: Agent Dispatch Contract

**Status:** Accepted
**Date:** 2026-04-25
**Decision makers:** Architecture team

## Context

ADR-004 sketched an "agent dispatcher" at `src/app/agent-dispatcher.ts`
that would receive a target phase, look up the agent type, and call
`AgentRegistry.spawn(...)`. The codebase that actually shipped settled on
a different layout (`src/orchestration/`, no `src/app/`) and a different
philosophy: the orchestrator is a planner that emits *events*, and any
component that decides "how to spawn an agent" lives outside Monsthera.
The 4-session orchestration plan formalises this as Session 2: complete
the orchestrator from a planner into a *planner + dispatcher + observer*
without giving Monsthera the ability to spawn agents itself.

The result is two bookends to a guard failure:

  - The planner identifies that an article cannot advance because a role
    has not contributed (template-defined or policy-defined per ADR-007).
  - Some external harness — a Claude Code hook, a CI runner, a human —
    needs to know about that gap, with enough context to act.

What was missing was the contract between the two: a typed, persistent,
deduplicated event stream describing *what was needed*, not *who was
spawned*.

## Decision

Ship a four-event lifecycle on top of the existing orchestration event
repository, plus an `AgentDispatcher` class that translates wave guard
failures into the request half of that lifecycle. Monsthera does NOT
spawn agents.

### Event lifecycle

```
agent_needed  ─►  agent_started  ─►  agent_completed
                                ─►  agent_failed
```

  - `agent_needed` — emitted by the dispatcher when a wave plan has a
    guard failure that names a missing role. Carries
    `{role, transition, reason, triggeredBy, contextPackSummary,
    requestedAt}` as the structured `details` payload.
  - `agent_started` / `agent_completed` / `agent_failed` — emitted by an
    external harness via `monsthera events emit` (CLI), `events_emit`
    (MCP), or `POST /api/events/emit` (HTTP). Carry
    `{role, transition, error?}`.

`agent_spawned` (a pre-existing event type from ADR-004's vocabulary)
remains in the union for back-compat but is not part of the new contract.

### Dispatcher reasoning

`AgentDispatcher.dispatchFor(failures)` walks each `GuardFailure` and
emits one `agent_needed` per missing role:

  - `policy_requirements_met` (ADR-007) → re-uses
    `getPolicyViolations` so the event carries `triggeredBy.policySlug`.
  - `min_enrichment_met` → walks `enrichmentRoles[]` and emits one
    request per `pending` role with `triggeredBy.guardName`.
  - `all_reviewers_approved` → walks `reviewers[]` and emits one
    `role="reviewer"` request per non-approved reviewer.
  - Content-shape guards (`has_objective`, `has_acceptance_criteria`,
    `implementation_linked`, `snapshot_ready`) are skipped — there is no
    role to dispatch; the article author must fill in the missing piece.

### Deduplication

Window-based: after `agent_needed` is emitted for `(workId, role,
transition)`, the dispatcher will not re-emit for
`MONSTHERA_DISPATCH_DEDUP_MS` (default 1h) unless an
`agent_started` / `agent_completed` / `agent_failed` for the same triple
appears later. Any of those three "closes" the slot and the next failure
pass re-emits.

Window-based dedup is resilient to a harness that crashes between
`agent_started` and the closing event: after the window the dispatcher
re-requests rather than waiting forever for a closing event that never
arrives.

### Guidance contract (§1.1)

Every `agent_needed` event carries a `contextPackSummary.guidance[]`
array with three required lines, in order:

  1. `Read context pack: build_context_pack({ work_id: <id>, query: <slug> })`
     — pointer to the full pack, NOT the pack itself (events must stay
     cheap to list/serialise).
  2. `cd <target-worktree> && pwd # safe-parallel-dispatch invariant from ADR-012`
     — when `MONSTHERA_DISPATCH_WORKTREE` is set, the literal path
     replaces `<target-worktree>`; otherwise the placeholder + an
     `--assert-worktree` alternative is shown.
  3. `Acting as <role>, contribute the <role> Perspective section to
     <work-slug>.` — the role-phrasing lets the agent understand what
     section to write.

The dispatcher is the first consumer of ADR-012's safe-parallel-dispatch
convention; future dispatch consumers must keep this guidance shape so
agents do not need per-source onboarding.

### Surfaces

  - **Wave loop**: `OrchestrationService.executeWave` invokes the
    dispatcher BEFORE advancing. Dispatcher faults are logged and
    swallowed — a dispatcher bug must not block the wave.
  - **CLI**: `monsthera events tail [--type T] [--limit N] [--follow]`
    streams JSON-lines to stdout (logs stay on stderr per AGENTS.md).
    `monsthera events emit --type ...` accepts only the three lifecycle
    states (not `agent_needed` — dispatcher-only).
  - **MCP**: `events_subscribe(filter)` returns `{events, cursor}` so a
    poll loop can ask for "events newer than `since=<cursor>`". MCP has
    no native push, so this is poll-with-cursor rather than a true
    subscription. `events_emit` mirrors the CLI emit.
  - **HTTP**: `GET /api/events?type=&workId=&limit=` and
    `POST /api/events/emit`, both Bearer-token gated.
  - **Dashboard**: `/events` page lists recent events with type filter,
    auto-refresh every 5s, and reveals `guidance[]` in a `<details>`
    block so a human can audit what was requested.

## Alternatives considered

  - **Outbound webhooks.** Rejected: events persisted in the
    orchestration repo can be replayed (CLI tail, MCP subscribe,
    dashboard render); a fire-and-forget webhook leaves no audit trail
    if the receiver was down.
  - **State-explicit dedup (track "open" vs "closed" per slot).**
    Rejected: a harness that crashes between `agent_started` and a
    closing event would deadlock the slot. The window-based fallback is
    self-healing.
  - **Embed the full context pack in the event.** Rejected: a typical
    pack is 50–200 KB; persisting that per event would balloon the
    `orchestration_events` table and slow down every list. The slim
    `contextPackSummary` is a pointer; the harness re-builds the pack.
  - **Let Monsthera spawn agents directly.** Rejected (ADR-008 is
    explicit): "how to spawn" is environment-specific (Claude Code hook,
    Codex hook, Cowork session, manual invocation); coupling Monsthera
    to one of those would block the others. The event contract is the
    minimum that all spawners can agree on.
  - **Re-use the existing `log_event` MCP tool for emit.** Rejected for
    the new surface: `log_event` accepts arbitrary types; the new
    `events_emit` deliberately restricts to the three harness-side
    lifecycle states so a malformed event cannot poison the contract.
    `log_event` continues to exist for the legacy event types.

## Consequences

Positive:

  - Monsthera's orchestration layer is now complete in the planner +
    dispatcher + observer sense. A wave loop in `autoAdvance` mode emits
    `agent_needed` requests every tick that a guard fails, so harnesses
    can react in seconds rather than waiting for human inspection.
  - The event log is the audit trail. Anyone — CLI, MCP, dashboard,
    future tools — can replay the dispatch decisions by reading the
    repo. `monsthera events tail` is the diagnostic flag for "what is
    the orchestrator asking for right now".
  - Adding a new spawner integration (a Codex harness, a Slack bot, a
    `gh actions` runner) is a one-way coupling: the new surface only
    needs to read `agent_needed` events and emit `agent_started` /
    `agent_completed` / `agent_failed`. Monsthera does not change.
  - `AgentDispatcher` is small, pure, and testable. Five new test files
    cover dispatcher behaviour, lifecycle dedup, policy-driven dispatch,
    guidance shape, and the CLI surface.

Negative:

  - Two event-type vocabularies coexist: `agent_spawned` (legacy) and
    `agent_needed` + the lifecycle (new). They are not interchangeable.
    Future cleanup may collapse them, but renaming an event type
    requires a migration of historical rows, so we kept both for now.
  - Dedup is window-based, not state-precise. A harness that drops
    `agent_failed` will see the next request only after the window
    elapses. The default (1h) is a trade-off; tune via
    `MONSTHERA_DISPATCH_DEDUP_MS`.
  - The dashboard `/events` page is read-only. A future PR can add an
    inline "in-flight agents on this work article" card on
    `public/pages/work.js` (deferred — work.js is 774 lines and would
    need its own slice).

## Cross-references

  - ADR-004 — original orchestration model (the dispatcher path
    `src/app/agent-dispatcher.ts` it sketches predates the current
    layout; the dispatcher actually lives at
    `src/orchestration/agent-dispatcher.ts`).
  - ADR-007 — knowledge-driven policy articles. The dispatcher is the
    primary downstream consumer of policy guard failures.
  - ADR-012 — drift prevention closure. The dispatcher's `guidance[]`
    convention references the safe-parallel-dispatch invariant
    established there.
  - `knowledge/notes/agent-dispatch-design-decisions.md` — pragmatic
    trade-offs not in this ADR.
