---
id: k-agent-dispatch-design-decisions
slug: agent-dispatch-design-decisions
title: "Decision: agent dispatch contract — events, not spawning"
category: decision
tags: [orchestration, dispatch, events, s2]
references: [adr-008-agent-dispatch-contract, adr-012-drift-prevention-closure]
createdAt: 2026-04-25T00:00:00Z
updatedAt: 2026-04-25T00:00:00Z
---

ADR-008 captures the formal decision (event lifecycle, dispatcher
shape). This note captures the *trade-offs* that did not earn space in
the ADR but matter for future contributors who think "why didn't they do
X instead?" — dogfooding the S5 convention that every non-trivial change
ships with a knowledge note alongside the ADR.

## Why events in `orchestrationRepo` instead of an outbound webhook

A persistent event row can be replayed by anyone — `monsthera events
tail`, the dashboard `/events` page, a future `gh actions` workflow that
reads the event repo on a cron. A webhook is a one-shot push; if the
receiver is down, the request is gone. We picked the path that is
*observable by default* even when the consumer is not running.

The cost is durability: every wave tick where a guard fails writes a row
(deduped, but still). Empirically the rate is one row per `(workId,
role)` per dedup window, which on a 50-article corpus with 1h windows is
under a few thousand rows per day — well inside what the in-memory and
Dolt repos handle without strain. If that ever stops being true, the
fallback is a "compaction" job that collapses
`agent_needed` → … → `agent_completed` chains into one summary row, the
same way the wiki bookkeeper compacts log entries.

## Why dedup is window-based, not state-explicit

Initial sketch: track an in-memory map of "open" requests and only emit
when the map says the slot is closed. Rejected once we walked through the
crash story:

  - Harness emits `agent_started` → starts work.
  - Harness crashes before emitting `agent_completed` or `agent_failed`.
  - The slot is forever "open" in the dispatcher's map; no new request
    fires; the article stalls until someone manually clears the state.

Window-based dedup is self-healing: after `MONSTHERA_DISPATCH_DEDUP_MS`,
the dispatcher re-requests. The default (1h) is intentionally generous
to give a real harness time to actually do the work; it can be tightened
to seconds in a CI environment via the env var.

The trade-off is responsiveness: a harness that drops `agent_failed`
will see a delay before the retry. We accepted that in exchange for the
crash-safety property.

## Why `contextPackSummary` is slim, not the pack itself

A typical context pack is 50–200 KB of JSON: ranked items, code refs,
freshness diagnostics, embeddings metadata. Persisting that per
`agent_needed` event would:

  - Inflate the event repo by orders of magnitude — `findRecent(50)`
    becomes a multi-megabyte query.
  - Stale the moment the underlying articles change — the harness would
    consume a snapshot of the pack from minutes ago instead of building
    fresh.
  - Force every consumer (CLI tail, dashboard, MCP) to render or skip
    arbitrarily-sized blobs.

The summary carries pointers (article slug, related slugs, code refs)
and the literal `guidance[]` lines. The harness re-builds the pack via
`build_context_pack(...)` at the moment it actually needs it. This keeps
events cheap to list and ensures the pack is always fresh.

## Why `guidance[]` references ADR-012 explicitly

ADR-012 (drift prevention closure) shipped two surfaces in S5 PR B:
`--assert-worktree` and `MONSTHERA_REQUIRE_WORKTREE`. Both exist
*because* unsupervised parallel agents had a habit of editing the wrong
working tree. The dispatcher is the first downstream consumer of that
convention, and we want every emitted request to remind the agent to
verify its `pwd` before writing.

The literal line carries the ADR reference (`safe-parallel-dispatch
invariant from ADR-012`) so an agent reading the guidance has a single
search term to find the rationale. Future dispatch-event consumers
(Codex hook, Cowork session manager) should adopt the same wording —
agents should not need per-source onboarding for the same invariant.

## Why `agent_needed` is dispatcher-only on the emit surfaces

The CLI, MCP, and HTTP `emit` surfaces all reject `agent_needed`. The
reason is dedup: if the harness can forge an `agent_needed`, it can
suppress legitimate ones (because the dispatcher would see it as "open"
and skip emission). The dispatcher is the only legitimate emitter of
that event type; everyone else lives in the
`agent_started` / `agent_completed` / `agent_failed` half of the
lifecycle.

This is enforced at three layers (CLI, MCP, HTTP) not because we expect
malicious input but because typos in a harness configuration are easy
and the failure mode (silent dedup of real requests) is hard to debug.

## Why no in-card "agent activity" surface on the work page yet

The spec mentioned showing in-flight agents on the `public/pages/work.js`
expanded card. `work.js` is 774 lines and the agent-event slice would
need its own card section, its own polling loop, and its own filter
state. We shipped the standalone `/events` page (which already supports
`?workId=` filtering at the API level) and deferred the in-card surface
to a follow-up. The contract is unchanged either way; only the
presentation changes.

## What this means for S3

S3 (convoys + requires + mid-session re-sync) does not modify the
dispatcher. It can, however, *consume* dispatch events: a convoy that
sees an open `agent_needed` for one of its articles can defer
advancement of dependent articles, treating the dispatch as a soft
block. That extension is additive — no protocol change required.
