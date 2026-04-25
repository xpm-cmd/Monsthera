---
id: k-91f42ekj
title: S5 plan: convoy dashboard
slug: s5-plan-convoy-dashboard
category: decision
tags: [plan, s5, convoys, dashboard]
codeRefs: []
references: []
createdAt: 2026-04-25T09:49:35.829Z
updatedAt: 2026-04-25T09:49:35.829Z
---

# S5 plan: convoy dashboard (S4 v2)

S4 v1 (PR #86) closed the operational loop around convoys at the
data-and-event layer: `convoy_get`, three lifecycle events for
provenance, a single-convoy invariant on `create`, and a
`convoy_lead_cancelled_warning` event when a lead is cancelled.

What S4 v2 (this plan) covers: the **dashboard surface** that turns
those events into something an operator can scan at a glance instead
of `events tail | jq`.

## Scope IN

### 1. Convoy panel on the dashboard

- A new `/convoys` page (and a card on the home dashboard) listing
  active convoys with: id, lead title + phase, member count,
  member-phase distribution (e.g. "2 in planning, 1 in implementation"),
  goal, age since `convoy_created`.
- Click-through to a per-convoy view that shows: full member list with
  per-member phase, the lead's recent `phase_advanced` events, the
  `convoy_lead_ready` guard state per member, and the convoy's own
  lifecycle events (created → completed/cancelled, with actor + reason
  if present).

### 2. Lead-cancelled-warning badge

- A persistent badge on the home dashboard when at least one
  unresolved `convoy_lead_cancelled_warning` exists.
- "Unresolved" = the convoy itself is still `active` and at least one
  member is still active (not in `done`/`cancelled`). Reading the
  warning is not enough; the operator must take a follow-up action
  (cancel convoy, reassign lead) to clear the badge.

### 3. Per-convoy lifecycle ribbon

- The lead's work-article page gets a ribbon showing all convoys
  (active + terminal) where this article is the lead, drawn from
  `convoy_created` events filtered by lead `workId`.

## Scope OUT

- **NO** new repository methods. The dashboard reads the existing
  `convoyRepo.findActive()`, `convoyRepo.findById()`, and
  `orchestrationRepo.findByType("convoy_*")`. If a query proves
  too slow, address with caching or a thin denormalised projection,
  not with new repo methods.
- **NO** auto-cascade UI ("cancel all members" button). Auto-cascade
  is explicitly out of scope per ADR-013; if operators ask for it
  *after* using the warning badge for a while, an opt-in cascade
  flag on `work advance --target cancelled` is the right shape, not
  a dashboard button.
- **NO** convoy mutation UI (no add/remove member, no setLead). The
  convoy API has no such methods; the dashboard mirrors the API
  surface.

## Open design questions

- **Member-phase distribution layout.** A stacked bar? A small ring?
  Brainstorm with frontend-design skill at session start.
- **Where does the warning badge live exactly?** Top of dashboard?
  Per-convoy card? Both? Lean toward: persistent top-of-dashboard
  badge that links to a filterable list of unresolved warnings.
- **Caching strategy.** First pass: query on every render. If that
  proves slow once we have many convoys, materialise an
  `active-convoy-summary` projection that the dashboard reads from a
  single endpoint.

## Pre-flight

- Verify the dashboard's existing event-stream subscription can carry
  the new event types without filter changes (`convoy_*` were added
  to `VALID_ORCHESTRATION_EVENT_TYPES` in S4 v1).
- Sketch the per-convoy view alongside the existing per-work-article
  view so the visual language is consistent.

## Sequencing

1. Read ADR-013 + the sibling design-decisions note for context.
2. Brainstorm with frontend-design skill — what does a 3-active-convoys
   dashboard look like? What's the smallest version that adds value?
3. Build the convoy panel + per-convoy view (read-only).
4. Add the unresolved-warning badge.
5. Add the lifecycle ribbon to work-article pages.
6. ADR-014 capturing the design choices.

## Why this is a knowledge article and not a doc

ADR-009 introduced the convention that plans live as searchable
knowledge, not as loose docs in `/docs`. This article is the canonical
landing for "what is S5 for convoys" — `monsthera search "S5 plan
convoy"` should find it.
