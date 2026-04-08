# ADR-004: Orchestration Model

**Status:** Accepted  
**Date:** 2026-04-07  
**Decision makers:** Architecture team

## Context

v2 lifecycle management was largely manual: agents or users called `update_ticket_status` directly, and a lifecycle reactor pattern fired hooks in response. There was no deterministic model for when a transition was valid, and automation was ad hoc. Multi-ticket coordination (waves, convoys) existed but was not integrated with the state machine.

v3 has deterministic guards (ADR-002). The orchestration model builds on that foundation to make phase transitions automatable while keeping manual override available and keeping the overall system conservative about taking autonomous action.

## Decision

A guard-driven state machine governs all phase transitions. The orchestrator evaluates guards on active work articles, dispatches agents when appropriate, and logs every action as a structured event. Auto-advance is configurable per template and per transition, not globally.

- Guards are pure functions: `(article: WorkArticle) => boolean`. The orchestrator calls them; it does not mutate articles directly.
- The orchestrator loop: scan all non-done work articles → for each, evaluate the guard set for the next phase → if all guards pass and auto-advance is enabled for this transition, advance the phase → otherwise, emit a `ready_to_advance` event and wait.
- Agents are spawned by the orchestrator when a phase requires active work (e.g., an enrichment agent is spawned per required enrichment role that has not yet contributed a section).
- Wave execution groups work articles by dependency order. Articles in the same wave have no inter-dependency and can be processed in parallel. Articles in later waves wait for earlier waves to complete.
- Convoy execution is a named group of waves with a shared goal. Convoys have a lead article whose completion unblocks the convoy.
- Auto-advance rules are declared in template definitions as `auto_advance: { from: 'planning', to: 'enrichment', when: 'guards_pass' }`. Conservative default: auto-advance is off unless explicitly declared.
- All orchestration actions (advance attempted, advance succeeded, agent spawned, guard failed) are written to the event repository with structured payloads.
- Manual override: any authorized agent or user can call the phase transition service directly, bypassing the orchestrator loop. The service still validates guards.

## Consequences

### Positive
- Deterministic guards mean orchestrator behavior is predictable and testable without running agents.
- Per-template auto-advance configuration allows different work types to have different automation levels (e.g., bugfixes auto-advance through enrichment, spikes do not).
- Event logging provides a complete audit trail of all orchestration decisions.
- Wave/convoy model makes multi-article coordination explicit and observable, replacing implicit sequencing.

### Negative
- The orchestrator loop introduces a polling interval — transitions do not fire instantly when guards become satisfied.
- Wave computation requires a dependency graph traversal; cycles will deadlock unless detected and surfaced.
- Conservative automation defaults mean teams must explicitly opt in to auto-advance; initial setup requires template configuration effort.

### Neutral
- The orchestrator is a long-running process. Teams deploying v3 must manage its lifecycle (start, stop, restart, health check).
- Manual override bypasses the orchestrator loop but still goes through the phase transition service, so guards are always enforced unless explicitly bypassed with `--force`.

## Implementation Notes

- Orchestrator: `src/app/orchestrator.ts`. Runs a `setInterval` loop at a configurable tick rate (default: 30 seconds).
- Guard evaluation: `src/domain/services/guard-evaluator.ts`. Receives an article and the target phase; returns `{ passed: boolean, failed: string[] }`.
- Agent dispatch: `src/app/agent-dispatcher.ts`. Looks up the agent type for the current phase transition and calls `AgentRegistry.spawn(type, context)`.
- Wave computation: `src/app/wave-planner.ts`. Topological sort of the dependency graph; surfaces cycles as orchestration errors.
- Event repository interface: `src/domain/ports/event-repository.ts`. Events are append-only; no update or delete.
- Auto-advance config location: `src/domain/templates/<template>.ts`, `autoAdvance` array field.
- The orchestrator exposes `pause()` and `resume()` methods for operator control. Pausing stops the loop but does not block manual transitions.
