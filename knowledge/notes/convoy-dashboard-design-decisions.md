---
id: k-convoy-dashboard-design-decisions
slug: convoy-dashboard-design-decisions
title: "Decision: convoy dashboard — panel, sidebar badge, ribbon"
category: decision
tags: [orchestration, convoys, dashboard, ui, s4-v2]
references: [adr-014-convoy-dashboard, adr-013-convoy-hardening, k-91f42ekj]
createdAt: 2026-04-26T00:00:00Z
updatedAt: 2026-04-26T00:00:00Z
---

ADR-014 captures the formal decisions: dedicated page, sidebar badge as
the single warning channel, ribbon co-located with the lead's work card,
no new repository methods, inferred-not-stored warning resolution, and
navigation-driven refresh in v1. This note captures the trade-offs that
did not earn ADR space but matter for whoever touches this code next. Same
pattern as the ADR-013 sibling note.

## Why phase chips with counts AND color, not a stacked bar

The stacked bar looks good in design mocks where the convoy has 10 members.
In practice today, a typical convoy has 3 members. At N=3, bar segments
mis-represent counts: you cannot tell "1 planning" from "2 planning" without
measuring pixels with your eye. The bar becomes a qualitative shape indicator
at best, and a misleading one at worst (two thin segments for "1 planning,
1 review" look the same as a thick segment for "3 planning").

Plain text (e.g., "planning: 2, review: 1") loses the color signal that lets
operators parse phase distribution in a table without reading words. Per-member
dots add identity — you could hover dot 2 and see "w-abc: planning" — but they
introduce an immediate UX question: what does a click do? We do not have a
navigate-to-member gesture wired. Scope creep without a clear payoff.

Chips give phase + count + color in one token. `3 planning` as a blue chip is
unambiguous. The trade-off: chip count tracks distinct phases, not individual
members; at N=10 you get 4 chips and lose the "shape of progress" gestalt you
would get from a bar. Acceptable for now — operators at current scale care
about counts more than shape. If we grow to convoys of 15+ members, a
mini-bar inside the chip (showing proportional width) would give both signals
without replacing the chip model.

## Why the sidebar badge instead of home banner or per-card highlight

Three candidate warning surfaces made it to the decision table: top-of-home
banner, per-row highlight on `/convoys`, and sidebar badge. The question was
whether a per-card approach alone was sufficient, or whether a more ambient
cross-page channel was needed.

The home banner failed the persistence test: navigate to `/work` and the
banner disappears. An operator deep in a backlog session can miss a warning
event that landed while they were triaging. That is the failure mode ADR-013's
`convoy_lead_cancelled_warning` event was designed to catch, so a warning
channel that fails when the operator is active rather than idle is worse than
useless.

The sidebar badge passes: it is page chrome, rendered in the layout shell,
visible from every page. The negative-space convention (absent when clean)
means operators learn to interpret absence as health, which is the right
default. Presence triggers investigation; absence is permission to focus. That
convention already has 15 years of muscle memory from chat apps. We got it for
free by matching the pattern. The trade-off is obvious: an operator who hides
the sidebar or uses a narrow viewport could miss the badge. Acceptable, because
the sidebar is not a separate destination — it is part of the frame.

The final design ships **three reinforcing surfaces** — not a single channel.
The sidebar badge is the cross-page ambient signal. On `/convoys` itself, there
are two additional surfaces: a dedicated "Unresolved warnings (N)" card rendered
at the TOP of the page (above the active stream), showing each warning's lead
title, convoy id, active member count, and reason; and a small inline warning
pill on each affected convoy card in the active stream. Active convoys are NOT
re-sorted — they stay in `findActive()` order; the dedicated warning card above
the stream is how warnings are prominently surfaced. The inline pill is a
secondary "catch it while scanning" signal for operators who scroll past the
warning section. An operator may encounter the warning via whichever surface
they happen to be looking at first.

## Why navigation-driven refresh instead of polling

The clean engineering answer was polling: one `setInterval` in the sidebar
initialization, call `refreshConvoyWarningBadge` every 30 seconds, done. It
would have taken a day, maybe less. We deliberately did not ship it.

The reason is not that polling is hard. The reason is that navigation-driven
refresh gets 95% of the UX value for 5% of the code, and polling adds cleanup
surface. The sidebar already runs `updateSidebar` on every page navigation, so
`refreshConvoyWarningBadge` rides that hook for free. Each page refetches on
mount, so navigating to `/convoys` immediately after a warning fires shows the
warning. The remaining 5% — an operator who loads `/work` and stares at it for
an hour — is not the operator we are designing for right now. That operator
can open a terminal.

The single-flight dedup pattern in `refreshConvoyWarningBadge` (a pending
flag that blocks concurrent refreshes) already handles rapid navigation without
multiple in-flight requests. Trailing-edge coalescing can be added when v2
polling lands; the structure of the function already supports it. Polling is
not rejected, it is literally one `setInterval` call away when operators
signal they need it.

## Why `/convoys/:id` is two-column instead of stacked

The stacked single-column layout was the initial direction, for consistency
with `/work` detail pages. It was overturned during commit 2 when we laid out
the four sections the per-convoy view needs: member list with phases, recent
activity (filtered events), lifecycle history (the phase ribbon from the
lead's perspective), and the guard status. Four sections stacked is a lot of
scroll for a page where the operator is in investigation mode, not scanning
mode.

An operator who navigated to `/convoys/:id` already knows what convoy they
care about; they are trying to answer "what is the current state, what happened
recently, what is blocking progress." Dense layout has a clear payoff for that
intent. The two-column layout (members + activity in the left column, lifecycle
+ guard in the right) keeps all four sections visible above the fold on a
standard laptop screen. Mobile collapses via the existing `.layout-split`
responsive rules — no new CSS needed.

The original stacked layout was easier to implement (no column grid) and is
more consistent with the rest of the dashboard. We traded consistency for
density because the investigation use case has a different reading pattern
than the scanning use case. If operators report the two-column layout is
confusing on smaller screens, the `.layout-split` rules already handle the
collapse; the fix is a CSS breakpoint adjustment, not a layout redesign.

## Why the ribbon is a compact strip, not a section block

The work card already carries 4–5 sections depending on the article's state:
reviewer list, dependency list, snapshot drift indicators, enrichment metadata.
A "Convoys led by this article" section heading with a content block would
follow the established card section pattern and would be easy to scan — but it
would make every non-lead work card one section heavier for the 80% of articles
that are not convoy leads.

The compact strip is hidden when the article is not a lead. Zero pixels added
in the common case. When it is visible, it surfaces the key information in the
most compact form: the convoy ids as pills, each linking to `/convoys/:id`.
The operator can see "this article leads two convoys" in one glance and click
through if they want detail.

The trade-off is scale: at 5+ convoys per lead, pills wrap onto a second line.
For current operator volume, that would be an unusual case and is not a problem.
If operators accumulate many convoys under a single lead article, the natural
upgrade is a "Leads N convoys (expand)" collapsed strip with a chevron. The
collapse can be added without touching the ribbon's data model.

## Phase color centralization in `renderPhaseChip`

This one is a lesson, not a decision. Commit 2 introduced a new `PHASE_VARIANT`
constant map in the convoy dashboard template to map phase names to chip color
variants. It was correct in isolation. What it did not check was whether a
`phaseVariant` function already existed in the codebase — and it did, in the
work card template. The result was two sources of truth for what color
`"planning"` should render.

Code review caught it before merge. We consolidated: `renderPhaseChip` in the
shared template helpers now delegates to the existing `phaseVariant` function.
The `/convoys` page and the work card now render the same color for the same
phase. If a designer changes the planning phase color, they change it in one
place.

The lesson: before writing a new helper that maps a well-known domain value
(phases, statuses, priorities) to a display attribute (color, icon, label),
search the codebase for the existing helper. It is almost always already there.
The recurring rookie mistake is adding a new constant file rather than checking
what the existing templates import. The project's convention is
`phaseVariant(phase)` — that function existed since the work panel shipped
in S1. The new dashboard's job was to call it, not reimplement it.

## Why `RecentLeadActivity.from` is optional and derived from `phaseHistory`

The spec assumed `phase_advanced` events had a `{ from, to }` payload — a
natural shape for a transition event. In practice, only
`OrchestrationService.tryAdvance` emits that shape. `WorkService.advancePhase`
— the path operators actually use when they run `monsthera work advance` from
the CLI — emits `{ to, phaseHistory }` with no `from` field. The convoy detail
page's "Recent lead activity" section would have rendered `undefined → planning`
for every transition the CLI produced, which is most of them. Not a test failure
in the traditional sense; just silently wrong output that would have been
confusing in production.

Rather than unify the event payload at emission (which would have required
touching both services and their tests, out of scope for dashboard work), the
projection derives `from` from `phaseHistory[length - 2].phase` when
`details.from` is missing. The `RecentLeadActivity` interface field was made
optional (`from?: WorkPhase`), and the UI handles the absent case gracefully
(`from ? \`${from} → ${to}\` : \`→ ${to}\``). The test "recentLeadActivity[0].from
comes from phaseHistory when not in event details" pins this behavior. Future
work that touches `phase_advanced` event consumers should not trust
`details.from` alone — always check `phaseHistory` as well, or take the
opportunity to unify the emission shape so both service paths include `from`.

## What we deliberately punted

- **Per-member click in distribution viz**: a future gesture where clicking
  the "2 planning" chip filters the member list to show which two members are
  in planning. The member list is already on the detail page; the chip click
  would add a filter affordance. Deferred until an operator actually asks for
  it.
- **Filterable warning list as a separate route**: `/convoys/warnings` showing
  only convoys with active lead-cancellation warnings. Over-engineered for
  current volume; warnings appear inline at the top of `/convoys` sorted there
  automatically.
- **SSE for real-time updates**: requires server-side subscription registry.
  Deferred to v3.
- **Clickable badge that deep-links to the specific warning context**: the badge
  today links to `/convoys` where warnings are at the top. A direct link to
  the specific warning row (e.g., `/convoys?highlight=cv-abc`) adds URL
  parameter parsing and highlight CSS for a marginal navigability gain.
  Deferred.
- **Trailing-edge coalescing for the badge refresh**: the single-flight pending
  flag prevents concurrent requests but drops trailing refreshes on rapid
  navigation. The trailing-edge pattern (call once more after the current
  request resolves) would catch the "navigated, badge refreshed, warning
  landed, navigated again, badge did not re-refresh" case. Deferred to v2
  alongside polling.
- **Real-time updates between navigations**: the 95% vs 5% split discussed
  above. Operators can use the CLI for real-time signal until the usage
  pattern demands it.
