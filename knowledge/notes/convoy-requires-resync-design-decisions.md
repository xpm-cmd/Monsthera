---
id: k-convoy-requires-resync-design-decisions
slug: convoy-requires-resync-design-decisions
title: "Decision: convoys, requires-as-hard-block, mid-session resync"
category: decision
tags: [orchestration, convoys, policies, resync, dispatch, s3]
references: [adr-009-convoys-requires-resync, adr-008-agent-dispatch-contract, adr-007-policy-articles, adr-004-orchestration-model]
createdAt: 2026-04-25T00:00:00Z
updatedAt: 2026-04-25T00:00:00Z
---

ADR-009 captures the formal decision (convoy types, hard-block guard,
new event types). This note captures the *trade-offs* that did not
earn space in the ADR but matter for future contributors who would
otherwise have to reverse-engineer the design choices from a diff.
Same dogfooding convention as ADR-008's sibling note.

## Why the convoy lead unblocks the convoy, not "all members done"

ADR-004 phrased the convoy contract as "the lead's completion unblocks
the convoy." We considered the alternative ("convoy completes when
every member is done") because it sounds more egalitarian. We rejected
it because it doesn't model what actually happens in practice:

A convoy exists because the lead establishes a contract — a public API
shape, a refactor's new file layout, a policy that the others
implement against. The lead is the source of truth. Members can't
meaningfully start until the lead has crystallised that contract; once
the lead has, the members are independent. "All members done" would
gate the lead on the members, which inverts the semantics.

The trade-off: an operator who wants "all members done" has to track
that condition externally. We considered exposing a second mode on the
convoy (`unblockMode: "lead" | "all"`) but punted — the universal case
is "lead unblocks." If we hit a real need for the alternative, the
field is small to add (and migrating existing convoys is a one-line
default).

## Why the convoy guard is *prepended*, not appended

`getGuardSet` returns guards in evaluation order; the dispatcher's
`collectSlots` walks the failed list in order and accumulates slots.
By prepending `convoy_lead_ready` we surface the convoy block FIRST in
the failed list — readers of `monsthera events tail` see "convoy not
ready" as the first failure on a member, not buried under a wall of
template / policy guard noise.

Mechanically this changes only display order — the dispatcher
explicitly returns no slots for `convoy_lead_ready` (passive wait), so
no `agent_needed` event fires from this guard. But human-readability of
the readiness report matters, and the prepend is free.

## Why `requires_chain` targets the referenced article, not the policy author

We considered three places to dispatch when `policy_requires_articles:
[B]` fails because B is not done:

1. Dispatch on A (the article whose policy failed) with a synthetic
   role like "wait_for_b". The harness would interpret this as a
   blocked-author signal.
2. Dispatch on B with the role appropriate for B's next phase
   (looking up B's enrichment roles, etc.).
3. Dispatch on B with a generic role ("author").

Option 1 is technically simpler — same workId as every other slot,
fits the existing dedup key. But it pushes the cross-article reasoning
out of Monsthera and onto the harness ("when you see this signal, look
up B yourself"). That's a worse contract because every harness
reimplements it.

Option 2 is "correct" but couples the dispatcher to lifecycle
internals. The dispatcher would need to call `lifecycle.getGuardSet`
on B to compute its missing roles. We dispatch from the dispatcher,
not from the lifecycle layer; reaching across is a design smell.

Option 3 — dispatch on B with `role: "author"` — is what we shipped.
"author" is the field already on `WorkArticle`, so the harness has a
clear "who do I notify" answer. The downside is that the role is
generic — but the `triggeredBy.blockingArticle` field tells the
harness exactly why, and the guidance line spells it out
("Advance B so A can pass policy X"). That's enough signal.

## Why `agent_needs_resync` is dispatch-like but `context_drift_detected` is observational

ADR-008's guidance contract was written for events the harness is
expected to act on — agent_needed always carries guidance because it
exists to provoke a spawn. We added two new event types in S3 and had
to decide whether each carries guidance.

`context_drift_detected` fires every tick where the snapshot has
moved. If we required guidance, the monitor would have to render a
new context pack on every tick — wasteful when most ticks are just
"yep, still drifting, no action needed". So we made it observational:
no guidance, the harness can correlate or ignore. A dashboard might
render a "drift" badge from these.

`agent_needs_resync` fires once per agent (when it crosses the 2×
threshold) and IS expected to provoke action — the harness reads it
and decides "respawn with a fresh pack" or "cancel". So it carries
guidance, mirroring the agent_needed shape.

The trade-off: a future tool reading the event stream has to know that
some new event types follow ADR-008's guidance contract and others
don't. We mitigate that by making the carve-out explicit in the ADR
and by registering both types in `INTERNAL_ONLY_EVENT_TYPES` — the
external `events_emit` whitelist refuses them, so only the resync
monitor can produce them, which means the contract is enforceable at
the type level.

## Why the resync monitor captures "original snapshot" itself instead of asking the harness

The simpler design would extend `AgentLifecycleDetails` with an
optional `snapshotId` field; the harness sets it on `agent_started`.
We rejected that because:

1. It breaks the ADR-008 contract. ADR-008 froze the lifecycle event
   shape; widening it forces every harness to update.
2. It puts the "what snapshot was I started with" question on the
   harness, which already has too many things to remember.
3. The monitor can do the lookup itself with no harness change. It
   queries `snapshotService.getLatest({workId, agentId})` the moment
   it observes `agent_started`. As long as a snapshot exists at that
   moment (which is the precondition for the agent being useful at
   all), the monitor captures it for free.

The downside: if no snapshot exists at start time, the monitor
silently skips tracking. That's the right semantics — we can't detect
drift on a non-existent baseline — and it's logged at debug level for
operators chasing edge cases.

## Why fail-closed on the hard-block lookup

`buildReferencedArticlePhases` calls `workRepo.findMany()` to build
the phase map. If that call fails, two paths exist:

1. **Fail open**: return `undefined`, the guard runs in legacy
   presence-only mode. The wave proceeds; A might advance even though
   B is not done.
2. **Fail closed**: propagate the error up, the wave fails. Operator
   sees the error in logs; the next wave retries.

Codex flagged option 1 as a regression and recommended option 2.
We agreed: the entire point of a "hard block" is that it doesn't
silently degrade. If the storage layer is sick, we can't trust
*any* guard evaluation, so halting the wave is the correct response.
The dedup window means the operator doesn't need to manually retry —
the next scheduled wave (or the operator's manual retry) will pick up
where we left off.

This is also internally consistent with how the convoy guard handles
its own enumeration failure: `buildConvoyLookup` fails open because
the worst case there is "members aren't gated on a lead they should
be" — slower than ideal but not unsafe. The hard-block guard is the
opposite: failing open IS unsafe.
