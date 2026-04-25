# ADR-013: Convoy Hardening — get, provenance events, single-convoy invariant

**Status:** Accepted
**Date:** 2026-04-25
**Decision makers:** Architecture team

## Context

ADR-009 shipped the convoy mechanic: a `Convoy` is `{lead, members, goal,
status, targetPhase}`, gated through the new `convoy_lead_ready` guard,
with a `requires_chain` dispatcher slot for cross-article waits. It
explicitly left three follow-ups open:

1. Convoy provenance via `convoy_created` / `convoy_completed` events.
2. A `convoy_get` MCP tool / `monsthera convoy get` CLI subcommand.
3. Auto-cancel cascade behavior — deferred to S4.

This ADR closes the **operational loop** around convoys. With S3, an
operator can form a convoy, wait for the lead, and complete it. What
they could not do: inspect a convoy by id, see who created it and when,
prevent a work article from being trapped in two convoys at once, or
get any signal at all when the lead of an active convoy is cancelled.
Members would silently stay blocked behind a dead lead. S4 v1 is the
minimum surface that lets a single operator run with three active
convoys without losing track.

## Decision

### 1. Provenance via lifecycle events

Three new orchestration event types capture convoy lifecycle:

  - **`convoy_created`** — emitted by `ConvoyRepository.create` after a
    successful insert. Payload `ConvoyCreatedEventDetails`:
    `{ convoyId, leadWorkId, memberWorkIds, goal, targetPhase, actor? }`.
  - **`convoy_completed`** / **`convoy_cancelled`** — emitted by the
    matching terminal transitions. Both share
    `ConvoyTerminalEventDetails`: `{ convoyId, leadWorkId, memberWorkIds,
    terminationReason?, actor? }`.

The envelope `workId` for all three is the **lead's** work id, so
`monsthera events tail --work <lead>` shows the convoy birth and death
inline with the lead's own lifecycle events. The `convoyId` is in
`details` for filtering.

`actor` and `terminationReason` are optional. The CLI extracts `actor`
from `--actor` (default: `$MONSTHERA_ACTOR`) and `terminationReason`
from `--reason`. The MCP tools accept matching fields. Both fields flow
into events but are NOT persisted on the `convoys` table itself — the
events table already encodes the time-series, so the convoys row stays
slim (current state only, no history).

#### Why provenance via events instead of `created_by` / `created_at_actor` columns

A `created_by` column on the `convoys` table answers exactly one
question ("who created this") and only at one time ("the moment of
creation"). The events table, which already exists, answers a
strictly larger set of questions ("who, when, what payload, in what
order alongside other lifecycle activity") at the cost of one
`logEvent` call per mutation. Adding columns would be a second
provenance store layered on top of an existing one.

Slim row + rich event log is also how `OrchestrationEvent`,
`EnvironmentSnapshot`, and the dispatcher's `agent_needed` already
work — convoys join the existing pattern rather than inventing a new
one.

#### Why register in `INTERNAL_ONLY_EVENT_TYPES`

`INTERNAL_ONLY_EVENT_TYPES` documents which event types are NOT in the
affirmative `events_emit` whitelist. The whitelist itself enforces by
allow-list, so the new types are already refused; the explicit
membership in `INTERNAL_ONLY_EVENT_TYPES` ties the policy at the type
level so a future contributor cannot accidentally add `convoy_created`
to the whitelist without noticing the contract.

### 2. Single-convoy invariant on `create`

A work article (lead or member) cannot appear in two **active** convoys
at the same time. Both `InMemoryConvoyRepository` and
`DoltConvoyRepository` enforce this in `create`: before persisting,
they scan active convoys for any overlap with the proposed lead +
deduped members; the first hit returns
`AlreadyExistsError("ConvoyMembership", offendingWorkId)`.

The invariant only applies to `active` convoys: once a convoy is
`completed` or `cancelled`, its members are free to join a new convoy.
This matches the operational intent ("only one in-flight contract per
article at a time") without forbidding legitimate sequential reuse.

#### Why enforce on `create` only and not on `update` / `addMember`

The convoy repository has no `update`, `addMember`, `removeMember`, or
`setLead` method, by design (S4 §"Scope OUT"). Membership is fixed at
creation; if the operator needs to change membership, they cancel the
convoy and create a new one. So `create` is the only mutation that can
introduce a conflict — there is no second enforcement point to wire.

If a future ADR adds membership mutation, the invariant must be
re-checked there too.

#### Why `AlreadyExistsError("ConvoyMembership", ...)` and not a new `ConvoyMembershipConflict` class

The error already round-trips through MCP as
`{ error: "ALREADY_EXISTS", message: ... }`. Tools and dashboards know
how to render that code. Minting a `ConvoyMembershipConflict` subclass
with its own code would force every consumer (MCP boundary, CLI error
formatter, tests) to learn about a new code without offering anything
the existing code does not. The `entity = "ConvoyMembership"` detail
already makes the failure unambiguous.

#### Why scan instead of a UNIQUE constraint on the database

`member_work_ids` is JSON-serialised inside the `convoys` row; the
relational primitives that enforce uniqueness across rows do not match
the shape. We could normalise to a `convoy_members` table with a
partial unique index (`status = 'active'`), but the active-convoy
count is small (tens, not millions) — a single `findActive()`
round-trip plus an in-process loop is the simpler primitive, and the
same shape works across both backends.

### 3. Lead cancellation produces a warning event, not an auto-cascade

When the lead of an active convoy transitions to `cancelled`, the work
service emits one `convoy_lead_cancelled_warning` event per affected
convoy: `{ convoyId, leadWorkId, memberWorkIds, reason }`. Members are
**not** auto-cancelled. The warning is the operator's signal to decide
whether to cancel the convoy, reassign the lead, or leave members
where they are.

The hook lives in `WorkService.advancePhase` — the only path to
`cancelled` (the service requires a `reason` flag for that target).
`OrchestrationService.tryAdvance` cannot reach `cancelled` because
`getNextPhase` never returns it; `cancelled` is a sink reachable only
by an explicit operator call.

#### Why warning-only and not an actual cascade

Two reasons:

1. **Symmetry with ADR-009's framing.** ADR-009 chose "lead unblocks
   the convoy" over "all members done unlocks" because the lead
   establishes the contract. Auto-cancelling members on lead
   cancellation would assume the lead's death automatically invalidates
   the contract — but the contract may already be partly delivered
   (members in `implementation` or `review`), and the operator is the
   right judge of whether to abandon, hand off, or keep going.
2. **Reversibility cost.** Cancellation requires a `reason` and is
   semi-terminal. An auto-cascade that turned out to be wrong would
   force the operator to recreate cancelled work articles — much
   higher cost than missing a warning event.

The warning event is the seed for an opt-in cascade: if operators
report "I keep forgetting to cancel the convoy after cancelling the
lead", a future `--auto-cancel-members` flag on `work advance --target
cancelled` would consume the same signal without changing the default.

### 4. `convoy_get` as a discrete tool / command

The new `convoy_get` MCP tool and `monsthera convoy get --id <cv>` CLI
subcommand return the full `Convoy` shape on success and `NOT_FOUND`
on an unknown id. The repository already supports this since S3
(`findById`); this is a pure surface addition.

#### Why a new tool instead of overloading `convoy_list --id`

`convoy_list` returns active convoys only — that is the documented
shape, and the dashboard / harness consumers depend on it. Overloading
it with an `--id` filter would either:

- Quietly return a single convoy (now `list` is two different shapes
  depending on flags), or
- Filter to active-only when `--id` matches a terminal convoy (the
  caller wanted to inspect a specific id, getting nothing back is
  confusing).

`convoy_get` is the explicit surface: one id in, one convoy or
`NOT_FOUND` out. Active and terminal convoys are equally accessible.

## Consequences

- Operators get four new operational primitives: see who created a
  convoy, see when it died and why, prevent membership ambiguity at
  creation, and react to lead cancellations.
- The `convoys` table stays at six columns. All provenance lives in
  the events table, which scales with mutation count rather than with
  schema width.
- The single-convoy invariant means a convoy creation can fail for a
  reason that is NOT shape-validated (the caller's id list is fine in
  isolation, just collides with another active convoy). MCP callers
  must distinguish `VALIDATION_FAILED` from `ALREADY_EXISTS` —
  documented in the tool descriptions.
- Lead cancellation surfaces the warning event but does not change
  member state. Dashboards and operators must read the warning to
  notice. Future S4 v2 work (a convoy dashboard) consumes this event
  to render a "lead cancelled, decide" badge.

## Alternatives considered

- **`created_by` and `cancelled_by` columns on the `convoys` table**:
  rejected. Two provenance stores instead of one; loses the time-series
  shape that lets `events tail --work <lead>` interleave convoy and
  lead lifecycle.
- **`ConvoyMembershipConflict` error subclass**: rejected. Adds a code
  every consumer must learn about with no payload that
  `AlreadyExistsError("ConvoyMembership", id)` does not already carry.
- **Auto-cascade-on-lead-cancellation, with an `--undo` window**:
  rejected for now. The undo window adds runtime state (a deferred
  cascade timer) and the failure mode of the timer (process restart
  before the window closes) is more complex than the current design.
  If the warning event proves insufficient, an opt-in cascade is the
  natural follow-up.
- **`convoy_list --id <cv>` instead of `convoy_get`**: rejected.
  Overloads `list`'s contract; obscures the active-only filter that
  the existing surface depends on.
- **UNIQUE-constraint enforcement of the single-convoy invariant via
  a normalised `convoy_members` table**: rejected for now. Larger
  schema change for a property that costs O(active_convoys) to enforce
  in process.
