# ADR-014: Convoy Dashboard — dedicated page, sidebar badge, lifecycle ribbon

**Status:** Accepted
**Date:** 2026-04-26
**Decision makers:** Architecture team

## Context

ADR-013 closed the convoy data and event layer: lifecycle events
(`convoy_created`, `convoy_completed`, `convoy_cancelled`,
`convoy_lead_cancelled_warning`) are now written to the events table,
the single-convoy invariant is enforced at creation, and the
`convoy_get` tool/command gives operators point-in-time access to any
convoy by id. That ADR explicitly deferred the visual surface: "Future
S4 v2 work (a convoy dashboard) consumes this event to render a
'lead cancelled, decide' badge."

S4 v2 ships that surface. Before this work, an operator managing three
active convoys had to `monsthera convoy list | jq` to see member
phases, `monsthera events tail --type convoy_lead_cancelled_warning`
to catch warnings, and mentally correlate the two. There was no ambient
signal for a degraded convoy state, no at-a-glance view of member
distribution, and no co-located indicator on the work card that
originated the convoy. The result: operators either over-polled the CLI
or missed warnings until members had been blocked behind a dead lead
for an extended time.

This ADR captures the six structural decisions made shipping the
dashboard screen and its supporting components.

## Decision

### 1. Dedicated `/convoys` page, not an overlay or inline panel

Convoys are a distinct grouping construct in the data model — they have
their own repository, their own lifecycle, their own event stream, and
their own `convoy_list` MCP tool. Surfacing them inside `/work` as an
overlay or as an additional panel column would force a choice between
burying them (toggle-hidden, hard to find) or polluting the work
panel's purpose (tracking individual articles) with grouping concerns.

A dedicated `/convoys` page mirrors the API surface: `convoy_list` is
its own tool with its own contract, and the dedicated page is the
visual analogue of that contract. Operators get a single bookmarkable
URL they can add to a browser bar or a status dashboard, and they can
navigate directly there without first landing on `/work`. The URL
surface is also clean for future deep-linking (`/convoys/:id` for
per-convoy detail).

The alternative considered was a collapsible right-hand panel on
`/work` showing active convoys. It was rejected because it duplicates
the member-list concern (work articles appear in both the main panel
and the convoy groupings), and the panel interaction model competes
for horizontal space with existing snapshot-diff and enrichment
details. A separate page has zero coupling to the work panel's layout.

### 2. Sidebar nav badge as the persistent cross-page warning channel — not a home banner

The original brainstorm included a top-of-home banner: a prominent
strip that appears when at least one active convoy has a cancelled
lead. That approach was rejected for alarm-fatigue reasons. A home
banner visible only on `/` is out of sight the moment the operator
navigates to `/work` or `/events` to investigate. If the same operator
is on the dashboard for hours, a banner that went orange during that
session is invisible until they navigate back to `/`. Routine lead
cancellations — more frequent as operators use the cancel/reassign
cycle that ADR-013 deliberately kept manual — would erode operator
reflex over time.

The sidebar badge is the **persistent cross-page ambient signal**: it
is rendered as part of the layout shell, not as part of any individual
page's content area. It is visible from `/work`, `/events`, `/convoys`,
everywhere. Critically, it is **silent when clean**: when no active
convoys have a cancelled lead, the badge is absent entirely. Absence
conveys health; that is the negative-space convention from chat
application unread counts, and it requires no explanation for operators
who have ever used a messaging app.

The home stat card continues to show convoy count (active convoys,
no ornamentation) because count alone is ambient context, not an
alert. It does not add warning styling — that would be a double
signal that trains operators to look in two places.

On the `/convoys` page itself, warnings are surfaced through two
additional reinforcing surfaces that complement the sidebar badge:

1. A dedicated **"Unresolved warnings (N)"** card rendered at the top
   of the page, above the active convoy stream. Each row in this card
   shows the lead title, convoy id (linked to `/convoys/:id`), active
   member count, and cancellation reason. This is the high-resolution
   investigation view — the operator can see every warning at a glance
   without scrolling through the full convoy list.
2. A small inline **warning pill** (`warning` badge in error variant)
   rendered next to the lead's title on each affected convoy card in
   the stream. Active convoys stay in `findActive()` order — they are
   NOT re-sorted by warning state. The pill is a secondary signal: an
   operator scanning the stream will notice it even if the dedicated
   warning card has scrolled out of view.

The three surfaces are intentionally redundant. An operator may
notice a warning via any of: (a) the sidebar badge from any page,
(b) the dedicated "Unresolved warnings" card when they open `/convoys`,
or (c) the inline pill on the affected convoy's card in the stream.
The sidebar badge is the only signal visible cross-page; the other two
are scoped to `/convoys` and provide increasing resolution for an
operator who is already investigating.

### 3. Lifecycle ribbon on the lead's work card, not on `/convoys`

The lead is where the operator is when they ask "what convoys did I
create?" A work article that is a convoy lead is already visible
on `/work`. Co-locating the ribbon with the work card puts the
answer at the point of question. The operator does not have to
navigate to `/convoys` to discover that the article they are looking
at is leading two active convoys — the ribbon is right there on the
card.

The ribbon is also the most natural place for the reverse lookup: the
operator sees `w-abc` on `/work`, notices the ribbon showing it is a
lead, clicks through to `/convoys/:id` to inspect the convoy detail.
That navigation flow is direct; starting from `/convoys` to discover
which work card to open is the reverse of how operators actually work.

The ribbon is **hidden when the article is not a lead** — it renders
zero pixels in the common case. A typical session where the operator
reviews a backlog of non-lead work articles incurs no visual cost from
the ribbon at all. The `convoy-projection.ts` module determines
lead-vs-member at render time; the template only emits the ribbon HTML
if `convoyLead` is non-null.

Placing the ribbon on `/convoys` instead was considered and rejected:
the convoy detail page already shows member list and phases. Adding a
reversed "which work article is the lead" view to `/convoys` would be
redundant with the existing lead field in the convoy record, and it
would be harder to navigate to (the operator must already be on
`/convoys` looking at the right convoy to reach the lead's detail via
the ribbon). The work card is the right anchor.

### 4. No new repository methods — dashboard composes existing queries

ADR-013 established the separation: the repository persists, the
dashboard renders. The new `src/dashboard/convoy-projection.ts` module
composes existing repository methods — `findActive()`,
`findById(id)`, `findByType("convoy_lead_cancelled_warning")` on the
events repository, and `workService.getWork(id)` — to compute the
projections that the dashboard pages and the sidebar badge consume.
No new method was added to `ConvoyRepository`, `EventRepository`, or
`WorkService`.

The trade-off is honest coupling: the dashboard is now coupled to
event type name strings. Renaming `convoy_lead_cancelled_warning`
would break `convoy-projection.ts` at the call site, and the failure
would surface as a test failure rather than silently returning zero
warnings. That failure mode is acceptable — the coupling lives in
one focused module that is explicitly the dashboard's projection
layer, not scattered across six UI template files.

The alternative was a new `getConvoyDashboardSummary()` method on a
service or repository. That approach would hide the coupling behind an
abstraction but would also make the abstraction a leaky one: the
summary method would need to know about event types anyway, so the
type-name coupling would merely migrate inward. Keeping the coupling
in `convoy-projection.ts` makes it visible and testable in one place.

### 5. Warning resolution is inferred from current state, not stored

A `convoy_lead_cancelled_warning` event has no `resolved_at`
timestamp. There is no UI action to "mark this warning resolved". A
warning is considered **unresolved** by the projection iff the convoy
is still `active` AND at least one member is not in `done` or
`cancelled`. The projection re-evaluates that condition on every
render.

When the operator acts — cancelling the convoy, or completing/
cancelling all members — the next page render finds the convoy is no
longer active, or finds no member in an open state, and the warning
silently disappears from the badge and from the `/convoys` warning
section. No manual "mark resolved" step is needed because the action
itself changes the state the projection reads.

This design honors ADR-013's principle: events are the time-series,
projections are the lens. The lens can be updated (changing what
constitutes "unresolved") without touching the events table or adding
a migration. If a future operator workflow requires "dismiss this
warning without acting on it" (i.e., snooze), that is a stored
preference, not a mutation to the event itself. The event remains an
immutable fact; a snooze table would be a separate concern.

Storing resolution — a `resolved_at` column on the event row, or a
separate `convoy_warning_resolved` event type — was considered and
rejected. `resolved_at` requires a column migration. A resolved event
requires a new UI action, a new event type, and projection logic that
must correlate the warning event with the resolution event by convoy
id and timestamp. Both approaches add state that the current
"re-derive from live data" model gets for free.

### 6. Refresh is navigation-driven in v1 — no polling, no SSE

The sidebar badge and all page data refresh on navigation. The badge
refreshes inside `updateSidebar`, which already runs on every page
navigation; each page fetches its data on mount. No `setInterval` is
set, no WebSocket is opened.

The freshness cost is explicit: an operator who loads `/work` and
then sits on it for an hour without navigating will not see a badge
for a `convoy_lead_cancelled_warning` that landed during that hour.
That cost is acceptable at current operator volume — operators
navigate the dashboard regularly as part of their workflow, and the
CLI (`monsthera events tail`) is always available for real-time
signal.

The architectural benefit is significant: navigation-driven refresh
adds no runtime state (no timer handles to track and clean up), no
cleanup logic in page teardown, and no coordination between the badge
and page-level fetch (they both independently re-fetch on mount,
which already handles the race condition of "badge shows warning,
user navigates to `/convoys`, page loads fresh data with the same
warning"). The endpoints the badge and pages consume are identical to
the endpoints v2 polling and v3 SSE would consume — upgrading the
refresh strategy later requires changing the trigger, not the data
shape.

Polling at a 30-second interval was considered as the simplest
"better than navigation-only" option. It was deferred to v2: the
`setInterval` + cleanup pattern is four lines, and the
`refreshConvoyWarningBadge` function is already extracted in a shape
that supports calling it on a timer. Deferred, not rejected.

SSE for live updates was considered as the ideal eventual state. It
was deferred to v3: SSE requires a persistent server-side event
stream, which is a server architecture change beyond the current
Express route model. The dashboard endpoints are stateless today;
SSE would require a subscription registry. Deferred until operator
usage signals it is needed.

## Consequences

- Operators get a 5-second scan of convoy state without dropping to
  `convoy list | jq`. The `/convoys` page shows all active convoys
  with member phase distribution, warnings at the top, and a link to
  per-convoy detail.
- The convoys table stays at six columns. The dashboard adds zero
  persistent state — no projection table, no resolved-at column, no
  snooze preferences.
- Renaming a convoy event type breaks `convoy-projection.ts` at the
  call site. The failure is local (one module) and surfaces via test,
  not silently through a missing badge.
- Three-surface warning redundancy (sidebar badge cross-page, dedicated
  "Unresolved warnings" card at the top of `/convoys`, inline pill on
  each affected convoy card) means most operators will encounter a
  warning via whichever surface they happen to be looking at. An
  operator who never glances at the sidebar will still see the warning
  card and inline pill when they open `/convoys`. Acceptable trade-off:
  the sidebar is the only ambient channel, but `/convoys` itself
  provides two reinforcing signals for investigators.
- The lifecycle ribbon scales to approximately five convoys per lead
  before pills wrap onto a second line. Not a problem at current
  scale; a "Lead of N convoys (expand)" collapse pattern is the
  natural upgrade if operators report it gets unwieldy.
- The phase chip palette is centralized in `renderPhaseChip`.
  Commit 2 of the dashboard consolidation aligned the new
  `PHASE_VARIANT` map with the existing `phaseVariant` function so
  that work cards and convoy pages use the same color for the same
  phase. Future phase additions require updating one location.

## Alternatives considered

- **Top-of-home banner for warnings**: rejected for alarm fatigue.
  Banner is invisible off the home page; degrades operator reflex
  for routine cancellations.
- **Per-convoy-card warning highlight as the ONLY channel, no sidebar
  badge**: rejected. A per-card pill or row highlight requires the
  operator to be on `/convoys` to see any warning signal at all —
  it defeats the ambient alerting purpose. The shipped design keeps the
  per-card inline pill as a secondary signal (within `/convoys`) but
  adds the sidebar badge as the primary cross-page channel so warnings
  are visible regardless of which page the operator is on.
- **Workspace layout (list + side panel) for `/convoys`**: rejected.
  Duplicates selection state (URL hash + side panel) and competes
  with the dedicated `/convoys/:id` detail page already implemented
  in commit 2.
- **Materialized projection table for convoy summaries**: deferred
  until profiling shows the live-query path is slow. At current
  convoy counts (tens), composing `findActive` + per-convoy
  `getWork` is fast enough.
- **Polling at 30-second interval for badge freshness**: deferred
  to v2. Navigation-driven refresh covers current operator volume.
  Single-flight dedup is already in place for rapid navigation.
- **SSE for live updates**: deferred to v3. Requires server-side
  subscription registry, a meaningful architecture change.
- **Per-member click in distribution chips**: punted. The per-convoy
  detail page already shows the full member list with phases;
  drill-through from the chip adds interaction complexity before
  any operator has asked for it.
- **Filterable warning list as a separate `/convoys/warnings` route**:
  over-engineered for current warning volume. Warnings appear inline
  at the top of `/convoys` where they are visible without an extra
  navigation step.
- **Overlay or inline panel on `/work`**: rejected. Pollutes the work
  panel with grouping concerns; competes for horizontal space with
  existing snapshot-diff and enrichment panels.
