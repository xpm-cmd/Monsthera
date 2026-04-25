---
id: k-convoy-hardening-design-decisions
slug: convoy-hardening-design-decisions
title: "Decision: convoy hardening — get, provenance events, single-convoy invariant"
category: decision
tags: [orchestration, convoys, provenance, events, s4]
references: [adr-013-convoy-hardening, adr-009-convoys-requires-resync, adr-008-agent-dispatch-contract]
createdAt: 2026-04-25T00:00:00Z
updatedAt: 2026-04-25T00:00:00Z
---

ADR-013 captures the formal decision (event types, the
single-convoy invariant, the warning-instead-of-cascade choice, and
`convoy_get` as a discrete tool). This note captures the *trade-offs*
that did not earn space in the ADR but matter for future contributors
who would otherwise have to reverse-engineer them from a diff. Same
dogfooding convention as ADR-009's sibling note.

## Why `actor` is optional everywhere instead of required

The natural argument for "always require actor" is auditability — if
every convoy mutation knows who triggered it, operators can answer
"who made this mess" without effort. We rejected required actor for
three reasons:

1. The orchestrator can form convoys autonomously from a
   `requires_chain` cluster. There is no human or agent id at that
   moment; manufacturing one ("agent-orchestrator") would be
   information without provenance value — every autonomous convoy
   would carry the same actor.
2. CLI ergonomics. `monsthera convoy create --lead w-x --members
   w-a,w-b --goal 'g'` is the muscle-memory shape from S3. Demanding
   `--actor` on every call would be a regression that operators
   route around with `MONSTHERA_ACTOR=anonymous` in their shell, which
   is auditing theatre.
3. The events table already carries `agentId` on the envelope when
   the underlying repository captures it. Operators who care about
   provenance can correlate `convoy_created` with the `agent_started`
   that triggered it; the convoy event itself is one more datapoint,
   not the only one.

The trade-off: terse `monsthera convoy complete --id cv-x` calls
land in events with no actor recorded. We accept that — the next
audit pass can answer "who did this" by joining against the work
phase history of the lead. If a future audit-heavy use case lands,
the field is small to make required (and migrating tools is a one-line
default).

## Why we reuse `AlreadyExistsError` instead of minting `ConvoyMembershipConflict`

The error class hierarchy in `src/core/errors.ts` is intentionally
shallow: nine error classes, each tied to an `ErrorCode` constant.
That shallowness is a feature — every layer (CLI, MCP, dashboard)
knows exactly nine codes to pretty-print, and the `error.code`
round-trips through MCP as a primitive string the JSON-RPC client can
switch on.

Adding `ConvoyMembershipConflict` with its own code (`MEMBERSHIP_CONFLICT`?
`CONVOY_CONFLICT`?) would force every consumer to learn about a tenth
code, and the new code would not encode anything that the existing
`AlreadyExistsError("ConvoyMembership", offendingWorkId)` does not
already say. The `entity = "ConvoyMembership"` detail is the
discriminator if a caller wants to branch.

The trade-off: a caller doing `if (err instanceof AlreadyExistsError)`
cannot tell convoy-membership conflicts apart from, say, a duplicate
work article id without inspecting `details.entity`. Acceptable
because convoy-membership conflicts only fire from one call site
(`ConvoyRepository.create`), so the call site already disambiguates.

## Why we ship the warning event without shipping a cascade

ADR-009 gave us the framing: convoys exist because the lead
establishes a contract, and the operator is the source of truth for
whether the contract still holds. When the lead is cancelled, the
contract MIGHT be invalidated (lead changed their mind about the API
shape) or might still be partly delivered (lead got hit by a bus,
members already implementing against the lead's last commit). The
operator knows; the orchestrator does not.

The minimal v1 is "make the operator aware". A warning event is the
literal smallest signal that does that — observable via
`monsthera events tail --type convoy_lead_cancelled_warning` and
trivially correlated by a future dashboard.

What we explicitly did NOT do, and why:

- **Auto-cancel members.** Reversibility is asymmetric: cancelling a
  work article requires a `reason` and writes an audit-trail entry;
  uncancelling does not exist. An auto-cascade that turns out to be
  wrong forces the operator to recreate work articles — strictly
  worse than missing a warning event.
- **`--auto-cancel-members` flag on `work advance --target cancelled`.**
  The right shape if operators report "I forget to cancel the convoy
  manually". Until then it is design speculation. The warning event is
  the seed it would consume.
- **Notify the harness.** The harness already subscribes to events;
  no new push channel is needed. If the harness wants to surface the
  warning to the operator's UI, it reads `events tail` and renders.

## Why `convoy_get` instead of folding `--id` into `convoy_list`

The natural temptation: `convoy list --id cv-x` returns one convoy.
We rejected it because `convoy list` already has a contract — "active
convoys, in creation order, default behavior" — and the dashboard /
the harness depend on that contract being stable.

`--id <cv>` would either change the return shape (single object vs
array — caller pain) or filter the active-only result set with the
single id (pointless when the caller wants to inspect a terminal
convoy). Neither was the right answer.

`convoy_get` is the explicit shape: one id, one convoy or NOT_FOUND.
Active and terminal convoys are equally accessible because that is
the question operators ask ("show me what cv-x looked like" includes
"show me cv-x even though it is cancelled").

The trade-off: one more tool name to remember in MCP and one more
subcommand on CLI. Acceptable — the cost is in autocomplete, not in
contract complexity.

## What we deliberately punted: convoy mutation after creation

The convoy API has `create`, `findById`, `findByMember`, `findActive`,
`complete`, `cancel`. There is no `addMember`, `removeMember`,
`setLead`, or `updateGoal`. Operators who need to change membership
must cancel the convoy and create a new one.

We considered an `update` method during S3 and again here. The
pattern that kept biting was: a lead cancels and gets reassigned —
the simplest model is "cancel convoy A, create convoy B with the new
lead". Adding `setLead` would let us avoid the cancel/create cycle
but introduces a new state transition (`active → active'`) that
needs its own audit-trail and a new event type, and it is not
obviously rarer than the cancel/create cycle. We left it out and
will reconsider only if operators report the cancel/create cycle is
painful in practice.

This is also why the single-convoy invariant lives in `create` only
— there is no second mutation point that could introduce a
conflict.
