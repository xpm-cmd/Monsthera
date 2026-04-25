# ADR-009: Convoys, Requires-as-Hard-Block, and Mid-Session Resync

**Status:** Accepted
**Date:** 2026-04-25
**Decision makers:** Architecture team

## Context

Three orchestration gaps were left open by ADRs 004, 007, and 008:

1. **Convoys** (ADR-004) were described as "named groups of waves with a
   shared goal, with a lead article whose completion unblocks the
   convoy" but no implementation shipped. There was no way to express
   "these N work articles depend on a leader's progress; gate them as a
   group."
2. **`policy_requires_articles`** (ADR-007) gated by *reference
   presence* only. A policy declaring `policy_requires_articles: [w-B]`
   passed as soon as A's frontmatter listed `w-B` — even if B was still
   in `planning`. The policy-as-contract framing breaks down when the
   dependency can be satisfied with a citation rather than the work
   actually being done.
3. **Mid-session context drift**: ADR-008 makes the dispatcher emit
   `agent_needed` once and lets the harness spawn an agent. If the
   spawned agent runs for 30 minutes, the snapshot it started from may
   no longer match the working tree. There was no mechanism to detect
   that drift and ask the harness to refresh or cancel.

Each gap is independently solvable, but they share the same code path
(planWave + the dispatcher) and the same operational shape (read by the
harness via `events_subscribe`), so we ship them as one ADR.

## Decision

### 1. Convoys as first-class repository state

A `Convoy` is `{id, leadWorkId, memberWorkIds[], goal, status, targetPhase, createdAt, completedAt?}`.
Status is one of `active | completed | cancelled`. Convoys are created,
listed, completed, and cancelled via `ConvoyRepository` (interface in
`src/orchestration/convoy-repository.ts`, in-memory impl, Dolt impl).

Members of an active convoy are gated by a new pure guard
`convoy_lead_ready(article, ctx)`. The orchestrator pre-loads active
convoys at the start of each `planWave` / `evaluateReadiness` pass and
hands the lifecycle layer a `convoyLeadByMember: Map` lookup;
`getGuardSet` prepends `convoy_lead_ready` to the returned guards
**only for non-terminal transitions** (cancellation and `done` are
never blocked by a convoy — operators must always be able to abandon a
member). Phase comparison uses the lead's template `phaseOrder` rather
than string compare so spike templates that skip phases are handled
correctly.

The lead is intentionally absent from the member lookup, so its own
guard set is unaffected — the lead's progress is what unblocks the
convoy.

Dispatcher behavior: a `convoy_lead_ready` guard failure produces
**zero** dispatcher slots. Waiting for the lead is a passive state,
not an `agent_needed` event. The lead is independently scanned by
`planWave` and dispatched on its own merits when its own guards fail.

#### Why convoys are first-class repository objects, not tags

A convoy needs distinguishable state (`active` vs `completed` vs
`cancelled`) and a distinguished member (the lead). Modeling that as a
free-form tag on each work article would scatter the same information
across N articles and require a "which articles share this tag" scan on
every wave. A repository with `findActive()` and `findByMember()`
matches the access pattern.

#### Why convoys are Dolt-only (carve-out from AGENTS.md §4)

AGENTS.md §4 makes Markdown the source of truth for *knowledge and work
articles*. Convoys are neither — they are orchestration state, like
`OrchestrationEvent` and `EnvironmentSnapshot`, which are also
Dolt-only and not represented as Markdown. A convoy file would be a
pure metadata sidecar with no human-authored content; the markdown
discipline buys nothing.

This is documented as the explicit carve-out so future readers do not
treat the absence of a `knowledge/convoys/` directory as a bug. A
follow-up could add `convoy_created` / `convoy_completed` events for
git-blame-style provenance ("who formed this convoy"); we kept that out
of scope to keep the surface tight.

### 2. `policy_requires_articles` as a hard block

Policies declaring `policy_requires_articles: [w-X]` now require that
the referenced work article is in `phase: done`, not just present in
`article.references`. Knowledge-article references (no phase) stay
silently exempt — the orchestrator only populates the phase map for
known work articles.

`PolicyGuardContext` gains an optional
`referencedArticlePhases: ReadonlyMap<string, WorkPhase>`. The guard
remains pure (AGENTS.md §6); the orchestrator pre-resolves phases at
`buildGuardDeps` time. `getPolicyViolations` now returns
`referencedArticlesNotDone: { id, currentPhase }[]` alongside the
existing `referencedArticles[]` for missing-presence violations.

#### Hand-off: requires_chain dispatch on the referenced article

When A's policy needs B done and B is not done, the dispatcher emits
**a new agent_needed event targeted at B** (not at A). The slot uses
`role: "author"`, `transition: { from: B.phase, to: getNextPhase(B) }`,
`reason: "requires_chain"`, and
`triggeredBy: { policySlug, blockingArticle: A.id }`. The harness reads
this as "advance B so A can proceed" — the work owner of B receives the
request, not a fresh enrichment slot on A.

The dispatcher's public contract — event shape, dedup window, guidance
contract — is unchanged. The change to `collectPolicySlots` and the
target-resolution logic in `dispatchFor` are additive: existing slots
(policy / template_enrichment / reviewer_missing) flow through
unmodified, and per-target dedup snapshots are cached so a single
`dispatchFor` call still emits all N reviewer requests for an article
that needs N reviewers.

#### Fail-closed on phase-lookup errors

If `buildReferencedArticlePhases` cannot enumerate work articles (a
storage error during `findMany`), `buildGuardDeps` returns an `err` and
both `evaluateReadiness` and `planWave` short-circuit. Failing closed
matters: the alternative (degrading to legacy presence-only) would
silently let A advance even though B is not done. Operators see a
loud error in logs; the next wave retries.

#### Why elevate `policy_requires_articles` only, not `WorkArticle.references`

ADR-007 says policies are the prescriptive control plane:
template-defined enrichment is the floor, policies are the contract.
Elevating the *policy* guard preserves that framing — a contract
explicitly says "B must be done," and the orchestrator enforces it.
Elevating arbitrary `WorkArticle.references` would conflate "I cited
this for context" with "I depend on this", which is a different
intent.

### 3. Mid-session resync

A new `ResyncMonitor` (in `src/orchestration/resync-monitor.ts`)
watches `agent_started` events, ticks at a configurable cadence
(`MONSTHERA_RESYNC_INTERVAL_MS`, default 10 min), and emits two new
event types:

  - **`context_drift_detected`** — observational. Fires on each tick
    where the snapshot the agent started with is no longer the latest
    one captured for `(workId, agentId)`. The `details` payload is
    `{role, originalSnapshotId, currentSnapshotId, ageMinutes, checkedAt}`.
    No `guidance[]` — the harness may correlate but is not required to
    act.
  - **`agent_needs_resync`** — dispatch-like. Fires when the agent has
    been running for at least `staleMultiplier × intervalMs` (default
    2×) without a closing event. Carries `contextPackSummary +
    guidance[]` so the harness can either re-spawn with a fresh pack
    or cancel the in-flight work. The agent is removed from tracking
    after this event fires; another `agent_started` would re-arm it.

The "original snapshot" is captured by the monitor the moment it
observes `agent_started`, by calling
`snapshotService.getLatest({workId, agentId})`. The harness does not
need to include a snapshot id in the lifecycle event payload — keeping
ADR-008's `AgentLifecycleDetails` shape unchanged.

#### Cold-start rehydration

On startup, the monitor scans recent `agent_started` events whose age
is below `intervalMs × 4` (default 40 min) and seeds tracking for any
that lack a matching `agent_completed` / `agent_failed`. Older starts
are abandoned; the dispatcher's dedup window is the right tool for
those cases. This means a process restart loses tracking for very
long-running agents — a known limitation, acceptable for an MVP.

#### Why time-based, not event-based

Lifecycle events come from the harness, which we don't control. We
cannot ask the harness to ping us periodically; we have to detect
staleness on our own clock. A polled, time-based monitor matches the
cadence of the wall clock that the agent is actually running against.

#### New event types and the ADR-008 guidance contract

ADR-008's `guidance[]` requirement applies to dispatch-style events
that the harness is expected to act on. We carve out `context_drift_detected`
as observational (no guidance, the harness is free to ignore it) and
keep `agent_needs_resync` aligned with the dispatch contract (carries
guidance + contextPackSummary, harness is expected to react). Both
event types are registered in `INTERNAL_ONLY_EVENT_TYPES` and refused
by the external `events_emit` whitelist — only the resync monitor
itself produces these.

## Consequences

  - Convoys give operators a primitive for managing dependent groups of
    work articles without inventing new dependency edges between them.
  - The hard block on `policy_requires_articles` means policies become
    promises about completed work, not just citations. Existing
    policies that relied on presence-only behavior need to migrate; the
    legacy mode is preserved when `referencedArticlePhases` is
    omitted, so existing tests stay green.
  - The resync monitor introduces a continuous-time component that the
    older planner-only orchestrator did not have. The monitor's
    in-memory state is lost on restart (rehydration recovers recent
    starts; older ones are dropped), so an operator looking at a
    long-running agent across a restart should rely on the harness's
    own dedup window rather than expecting a drift signal.
  - The `requires_chain` reason is the first time a dispatcher slot
    targets an article *other than the one that triggered the guard
    failure*. The dispatcher's per-target dedup snapshot cache and
    `resolveSlotTarget` helper are general — future cross-article
    dispatch reasons can plug in the same way.

## Alternatives considered

  - **Convoy as a tag on work articles**: rejected. State (active /
    completed / cancelled) doesn't fit a tag, and "find active convoys"
    is a hot path that should be a single index lookup, not a scan.
  - **`policy_requires_articles` extended via `WorkArticle.references`
    on every guard pass**: rejected. Conflates citation with dependency
    semantics. Policies are the prescriptive control plane; references
    are descriptive context.
  - **Polling-based resync** (no event hook): viable but burns
    repository scans. The push hook on `events emit` (CLI + MCP)
    catches `agent_started` synchronously and starts tracking with no
    extra I/O.
  - **Dispatcher walks `WorkArticle.references` itself rather than
    targeting a different article in the slot**: rejected. The
    dispatcher's job is to translate guard failures into events, not
    to traverse the work graph. Letting `collectPolicySlots` synthesize
    a slot for B keeps the traversal localized to the policy semantics
    (which already knows about referenced articles).

## Open follow-ups

  - Convoy provenance via `convoy_created` / `convoy_completed`
    orchestration events. The repository is in place; the events are
    not yet emitted.
  - A `convoy_get` MCP tool / `monsthera convoy get` CLI subcommand for
    inspecting a single convoy by id.
  - Auto-cancel cascade: when a convoy lead is cancelled, today nothing
    happens to members. Out of scope for S3; deferred to S4.
