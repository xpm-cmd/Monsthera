# Convoy Dashboard (S4 v2) — Design Spec

**Status:** Brainstorm complete, ready for implementation plan
**Date:** 2026-04-26
**Branch:** `feat/convoy-dashboard`
**Supersedes:** none (extends [knowledge `k-91f42ekj`](../../../knowledge/notes/s5-plan-convoy-dashboard.md))
**Eventual ADR:** ADR-014 (written at PR close, captures formal decisions)

## Why

S4 v1 (PR [#86](https://github.com/xpm-cmd/Monsthera/pull/86)) closed the data + event layer for convoys: `convoy_get`, three lifecycle events, single-convoy invariant, and `convoy_lead_cancelled_warning` when a lead is cancelled. What it did not give the operator: a screen.

S4 v2 — this work — is the dashboard surface that turns those events into something an operator with three active convoys opens at 9am and reads in five seconds, instead of `events tail | jq`.

Three blocks ship in one PR:
1. Convoy panel + per-convoy view (read-only)
2. Sidebar nav badge for unresolved warnings
3. Lifecycle ribbon on the lead's work card

Reference: [ADR-013](../../adrs/013-convoy-hardening.md) for the warning-only-no-cascade decision; [convoy-hardening-design-decisions](../../../knowledge/notes/convoy-hardening-design-decisions.md) for informal trade-offs.

## Locked design decisions (from brainstorm)

| # | Decision | Form |
|---|---|---|
| 1 | `/convoys` overall shape | **Stream + drill-down** — single-column stack of convoy cards. Click navigates to `/convoys/:id`. Warnings render inline at top of `/convoys`. |
| 2 | Member-phase distribution | **Phase chips with counts** — `[planning ×2] [spec ×1]`, color per phase. Reuse existing `renderBadge` palette via a new `renderPhaseChip(phase)` helper. |
| 3 | Warning indicator | **Sidebar nav badge only** — red count next to "Convoys" iff there are unresolved warnings, absent otherwise. Home dashboard stays calm; the count of convoys lives in a stat card without warning ornamentation. |
| 4 | Per-convoy view (`/convoys/:id`) | **Two-column workspace** — guard inline in header, members left, event streams (lead activity + convoy lifecycle) right. |
| 5 | Lifecycle ribbon on work card | **Compact strip near title** — pills colored by status; terminal convoys muted (line-through). Hidden when the article isn't a lead. |

## Architecture

### Backend

#### New module: `src/dashboard/convoy-projection.ts`

Pure functions, dependency-injected, easy to unit-test. Lives in `src/dashboard/` (not in `src/orchestration/`) by ADR-013's "repo persists, dashboard renders" boundary.

```ts
export interface EnrichedConvoy {
  readonly id: ConvoyId;
  readonly leadWorkId: WorkId;
  readonly memberWorkIds: readonly WorkId[];
  readonly goal: string;
  readonly targetPhase: WorkPhase;
  readonly status: ConvoyStatus;
  readonly createdAt: Timestamp;
  readonly completedAt?: Timestamp;
  readonly lead: { id: WorkId; title: string; phase: WorkPhase } | { id: WorkId; deleted: true };
  readonly members: ReadonlyArray<{ id: WorkId; title: string; phase: WorkPhase } | { id: WorkId; deleted: true }>;
  readonly hasUnresolvedWarning: boolean;
}

export interface UnresolvedWarning {
  readonly convoyId: ConvoyId;
  readonly leadWorkId: WorkId;
  readonly memberWorkIds: readonly WorkId[];
  readonly reason: string;
  readonly createdAt: Timestamp;
  readonly leadTitle: string;            // for inline display, "(deleted)" if missing
  readonly activeMemberCount: number;
}

export interface ConvoyDashboardSummary {
  readonly active: readonly EnrichedConvoy[];
  readonly terminal: readonly EnrichedConvoy[];   // last 20 by completedAt desc
  readonly warnings: readonly UnresolvedWarning[];
}

export interface ConvoyGuardState {
  readonly name: "convoy_lead_ready";
  readonly passing: boolean;
  readonly leadPhase: WorkPhase;
  readonly targetPhase: WorkPhase;
}

export interface ConvoyLifecycleEntry {
  readonly eventType: "convoy_created" | "convoy_completed" | "convoy_cancelled" | "convoy_lead_cancelled_warning";
  readonly createdAt: Timestamp;
  readonly actor?: AgentId;
  readonly terminationReason?: string;
  readonly warningReason?: string;
}

export interface ConvoyDetailProjection extends EnrichedConvoy {
  readonly guard: ConvoyGuardState | null;        // null when convoy is terminal
  readonly recentLeadActivity: ReadonlyArray<{   // last 5, newest first
    readonly eventType: "phase_advanced";
    readonly from: WorkPhase;
    readonly to: WorkPhase;
    readonly createdAt: Timestamp;
  }>;
  readonly lifecycle: readonly ConvoyLifecycleEntry[];
  readonly warning: { reason: string; createdAt: Timestamp; activeMemberCount: number } | null;
}

export interface ConvoyProjectionDeps {
  readonly convoyRepo: ConvoyRepository;
  readonly orchestrationRepo: OrchestrationEventRepository;
  readonly workRepo: WorkRepository;
  readonly now?: () => Date;                      // for deterministic tests
}

export async function buildConvoyDashboardSummary(
  deps: ConvoyProjectionDeps,
): Promise<Result<ConvoyDashboardSummary, StorageError>>;

export async function buildConvoyDetail(
  id: ConvoyId,
  deps: ConvoyProjectionDeps,
): Promise<Result<ConvoyDetailProjection, NotFoundError | StorageError>>;
```

#### New HTTP handlers in `src/dashboard/index.ts`

Two thin handlers calling the projection. Pattern matches the existing `enrichKnowledgeArticleForApi` flow.

```
GET /api/convoys           → buildConvoyDashboardSummary → JSON
GET /api/convoys/:id       → buildConvoyDetail(id)       → JSON | 404
```

Auth: same `requireAuth` middleware as everything else under `/api/`.

#### How "unresolved" is computed (no new repo methods)

```pseudo
warnings = orchestrationRepo.findByType("convoy_lead_cancelled_warning")
unresolved = []
for w in warnings:
  convoy = await convoyRepo.findById(w.details.convoyId)
  if !convoy or convoy.status !== "active": continue
  members = await Promise.all(w.details.memberWorkIds.map(workRepo.findById))
  active = members.filter(m => m.ok && !["done","cancelled"].includes(m.value.phase))
  if active.length === 0: continue
  unresolved.push({ ...w.details, activeMemberCount: active.length, leadTitle: ... })
```

Resolution is **inferred from current state**, not stored. Cancelling the convoy from the CLI causes the next dashboard render to drop the warning automatically. No UI-driven "mark resolved" action; no "resolved_at" column on the event.

#### How terminal convoys + ribbon data is fetched (no new repo methods)

`orchestrationRepo.findByType("convoy_created")` returns every convoy ever created. Sort by `createdAt` desc, take last 50, look up current state via `convoyRepo.findById`. Filter to `status !== "active"`, take 20. The lead's ribbon filters this list by `leadWorkId === article.id` and adds active convoys from `findActive()`.

The 50/20 windows are conservative caps; they bound dashboard latency without losing recent terminal convoys (which is what the ribbon needs).

### Frontend

#### New files
- `public/pages/convoys.js` — list page (`/convoys`)
- `public/pages/convoy.js` — detail page (`/convoys/:id`)

#### Modified files
- `public/app.js` — register `/convoys` and `/convoys/:id`
- `public/lib/api.js` — add `getConvoys()` and `getConvoyById(id)`
- `public/lib/sidebar.js` — add Convoys nav item; `updateSidebar` triggers an async warning-count refresh
- `public/lib/components.js` — add `renderPhaseChip(phase)` (centralizes phase color palette)
- `public/pages/overview.js` — add `getConvoys()` to the existing `Promise.all` on mount; render a stat card showing `data.active.length`. No warning ornamentation here — that's the sidebar's job.
- `public/pages/work.js` — render lifecycle ribbon strip in expanded card when the article is the lead of any convoy

#### Sidebar badge refresh model

`updateSidebar(currentPath)` in [sidebar.js](public/lib/sidebar.js) currently runs synchronously on every navigation (called by `loadPage` in [app.js](public/app.js)). We add an async side-effect: kick off `getConvoys()`, read `data.warnings.length`, update a single `<span id="convoy-warning-badge">` in-place. No timers; the badge refreshes exactly when the operator navigates, which is when they care.

If the fetch fails, the badge stays at its previous value (silent retry on next nav). No error toast.

If a future operator reports stale UI between navigations, polling becomes a one-line addition: `setInterval(refreshBadge, 30_000)` registered alongside the theme-toggle handler.

#### Phase chip palette

The phase → color mapping centralizes in `renderPhaseChip(phase)`:

| Phase | Variant | Rough hue |
|---|---|---|
| `inception` / `spec` | `outline` / `secondary` | grey |
| `planning` | `primary` | blue |
| `implementation` | `success-adjacent` | green |
| `review` | `warning` | amber |
| `done` | `success` | green |
| `cancelled` | muted strikethrough | red-grey |

This helper replaces ad-hoc inline colors throughout `/work` and the new `/convoys` pages — single source of truth.

## Edge cases

| Case | Behavior |
|---|---|
| `/convoys` with zero active and zero warnings | Friendly empty state: "No active convoys. Group work articles around a lead with `monsthera convoy create`." |
| `/convoys/:id` with unknown id | 404 page with "Convoy not found" + back link to `/convoys` |
| Convoy with lead article deleted | Lead row shows `(deleted)`; everything else still renders |
| Convoy with member work article deleted | Member row shows `(deleted)`; member excluded from `activeMemberCount` (cannot be active if non-existent) |
| Active convoy where lead reached target | Guard section: `passing — lead at <phase>, target was <phase>` |
| Terminal convoy | Guard section hidden; lifecycle card features the terminal event prominently with actor + reason |
| Convoy with no `convoy_created` event (legacy) | Lifecycle just shows what's there; no crash, no fabricated event |
| Sidebar badge with zero unresolved | Badge node not rendered (no `0` shown) |
| Sidebar badge fetch fails | Previous count preserved; silent retry on next navigation |
| Work article is lead of zero convoys | Ribbon strip not rendered (zero pixels added to card) |
| Work article is lead of many convoys (5+) | Pills wrap to additional rows; terminal pills muted |

## Testing

### Unit: `tests/unit/convoy-projection.test.ts` (new)

Covers `buildConvoyDashboardSummary` and `buildConvoyDetail` with in-memory repos and frozen clock:

- Active convoy returned with full lead/member enrichment
- Convoy with deleted lead shows `(deleted)` placeholder
- Convoy with deleted member excluded from `activeMemberCount`
- Warning resolved by convoy termination → dropped from `warnings`
- Warning resolved by all members done → dropped from `warnings`
- Warning unresolved → present with correct `activeMemberCount`
- Active convoy where lead reached target → guard `passing`
- Terminal convoy detail → guard null, lifecycle includes terminal event
- Unknown convoy id → `NotFoundError`
- Multiple warnings on the same convoy (theoretical, defensive) → newest one wins

### Integration: `tests/integration/convoy-dashboard.test.ts` (new)

Uses `createTestContainer()` (existing pattern). End-to-end scenario:

1. Create three work articles + a convoy with one as lead, two as members
2. `GET /api/convoys` → assert `active.length === 1`, `warnings.length === 0`
3. Cancel the lead with `--reason` (emits `convoy_lead_cancelled_warning`)
4. `GET /api/convoys` → assert `warnings.length === 1`, warning has correct `activeMemberCount`
5. `GET /api/convoys/:id` for the warned convoy → assert `warning` field present
6. Cancel the convoy itself → re-GET → assert `warnings.length === 0` (resolved by termination)

### Smoke (manual)

Per the next-session prompt: start `monsthera dashboard`, navigate to `/`, `/convoys`, `/convoys/:id`, expand a work card whose article is a lead. Visual sanity check.

## Refresh strategy

- **v1**: navigation-driven. Each page re-fetches on mount. Sidebar badge refreshes inside `updateSidebar`. No timers.
- **v2** (deferred): polling on `getConvoys()` every 30s when on `/`, `/convoys`, or any work page. Same endpoints, no backend change.
- **v3** (speculative): SSE on the events stream filtered to `convoy_*`. Live updates without polling. Out of scope.

## Scope OUT (reaffirmed)

- **No new repository methods.** Reuse `convoyRepo.findActive()`, `findById()`, `findByMember()`, `orchestrationRepo.findByType("convoy_*")`. The dashboard layer composes; if a query proves slow, it caches.
- **No auto-cascade UI.** ADR-013 left "cancel all members" out for sound reversibility reasons. The opt-in shape, when it lands, is `work advance --target cancelled --auto-cancel-members`, not a dashboard button.
- **No convoy mutation UI.** No add/remove member, no setLead, no goal edit. The repo has no such methods; the dashboard mirrors the API surface.
- **No push notifications.** No Slack, no email. The sidebar badge is the channel.
- **No real-time polling.** v1 is navigation-driven. Polling is the documented v2.

## Acceptance

- Lint, typecheck, build, tests all green
- New unit tests for projection module
- New integration test for the convoy dashboard endpoint
- Smoke test passes manually per prompt
- ADR-014 + `convoy-dashboard-design-decisions.md` knowledge note written and committed in the same PR

## Open questions

None at brainstorm close. All five visual decisions locked; the projection contract is concrete; the test plan is specific.
