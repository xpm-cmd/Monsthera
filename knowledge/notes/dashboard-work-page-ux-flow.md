---
id: k-5nuw1j8i
title: Dashboard work page UX flow
slug: dashboard-work-page-ux-flow
category: context
tags: [dashboard, work, ux, lifecycle, orchestration]
codeRefs: [public/pages/work.js, src/dashboard/index.ts]
references: []
createdAt: 2026-04-11T02:19:06.860Z
updatedAt: 2026-04-20T00:00:00.000Z
---

# Dashboard work page UX flow

The work page (`public/pages/work.js`) manages work articles through their full lifecycle. It supports three view modes, multi-dimensional filtering, inline editing, and orchestration controls for enrichment, review, dependencies, and phase advancement.

## Layout structure

```
┌──────────────────────────────────────────────────────────────┐
│ Page header: "Work" + [New article / Hide create form] [Guide] │
├──────────────────────────────────────────────────────────────┤
│ Flash notification (success/error)                           │
├──────────────────────────────────────────────────────────────┤
│ Hero callout: execution contract guidance                    │
│   Steps: Shape → Ground → Gate                               │
├──────────────────────────────────────────────────────────────┤
│ Stat cards: Ready wave | Blocked | Pending reviews | Unassigned │
├──────────────────────────────────────────────────────────────┤
│ [Create form — shown when showCreate is true]                │
├──────────────────────────────────────────────────────────────┤
│ Toolbar: Search | Phase filter | Priority filter | State filter │
├──────────────────────────────────────────────────────────────┤
│ View tabs: [Queue] [Board] [List]                            │
├──────────────────────────────────────────────────────────────┤
│ "Showing X of Y article(s)"                                  │
├──────────────────────────────────────────────────────────────┤
│ View body (cards / board columns / table)                    │
└──────────────────────────────────────────────────────────────┘
```

## Initial data loading

Three parallel API calls on render:

```js
let [workArticles, directory, wave] = await Promise.all([
  getWork(),
  getAgents(),
  getOrchestrationWave(),
]);
```

- `workArticles`: all work items
- `directory`: agent registry with summary stats
- `wave`: orchestration wave with ready/blocked items

## State variables

- `viewMode`: "queue" (default) | "board" | "list"
- `expandedId`: which work card is expanded (queue view only), null = none
- `showCreate`: boolean, starts `true` (create form visible by default)
- `flash`: success/error notification
- `filters`: `{ query, phase, priority, state }` all defaulting to "all"

## Filtering system

The toolbar provides four filter dimensions:

1. **Search** (`data-filter-input`): Free-text substring match across id, title, template, phase, priority, author, lead, assignee, tags, references, codeRefs, and content. Updates on `input` event with cursor preservation.

2. **Phase** (`data-filter-select`): Dropdown for planning / enrichment / implementation / review / done.

3. **Priority** (`data-filter-select`): Dropdown for critical / high / medium / low.

4. **State** (`data-filter-select`): Smart composite filters:
   - "All work" — no state filter
   - "Ready wave" — only articles in the orchestration wave's ready set
   - "Blocked" — articles with `blockedBy.length > 0`
   - "Needs review" — articles with any reviewer in `pending` status
   - "Unassigned impl" — articles in `implementation` phase without an assignee

Dropdown changes fire on `change` event via `data-filter-select`, updating `filters[select.name]` and re-rendering.

## Three view modes

### Queue view (default)
Work cards rendered as collapsible cards. Each card shows:
- Title with status badges (phase, priority, ready indicator, blocked indicator)
- Template, author, assignee info
- Content preview (first 220 chars)

**Expand/collapse**: Clicking anywhere on the card (except buttons, inputs, forms, links) toggles `expandedId`. If clicking the already-expanded card, it collapses.

### Board view
Kanban-style columns for each phase (planning → enrichment → implementation → review → done). Each column shows its article count in the header. Cards are simplified: title, assignee, priority badge, ready badge.

### List view
Table rendered via `renderTable()` with columns: ID, Title, Phase (badge), Priority (badge), Assignee, Updated (timeAgo).

View switching uses `data-tab` click handler, which also resets `expandedId` to null.

## Create form

Shown when `showCreate` is true. Uses a three-column grid layout. Fields:

| Field | Type | Default | Required |
|-------|------|---------|----------|
| Title | text | — | yes |
| Author | text + datalist | — | yes |
| Lead | text + datalist | — | no |
| Template | select | feature | no |
| Priority | select | medium | no |
| Assignee | text + datalist | — | no |
| Tags | text (CSV) | — | no |
| References | text (CSV) | — | no |
| Code refs | text (CSV) | — | no |
| Content | textarea | — | no |

### Agent datalist
The page builds a `<datalist id="agent-options">` by collecting agent IDs from:
1. The agent directory (`getAgents()`)
2. All authors, leads, assignees from existing work articles
3. All reviewer and enrichment role agent IDs

This datalist provides autocomplete for author, lead, assignee, and reviewer fields.

On submit, calls `createWork()` via `runMutation()`, then resets the form.

## Expanded card: inline editing

When a card is expanded in queue view, it reveals:

### Edit form (`data-work-edit="id"`)
Pre-populated fields for title, lead, assignee, priority, tags, references, codeRefs, content. On submit, calls `updateWork(id, {...})` preserving the expanded ID.

### Lifecycle advancement
- Shows a "Move to [next phase]" button (`data-advance-work="id" data-phase="next"`).
- Phase progression: planning → enrichment → implementation → review → done (defined in `NEXT_PHASE` map).
- If the article is in the orchestration wave's ready set, shows a "ready to advance" success badge.
- Calls `advanceWork(id, phase)` via `runMutation()`.

### Enrichment panel
Lists enrichment roles with their status (pending/contributed/skipped) and agent ID. For articles in `enrichment` phase with `pending` roles, shows action buttons:
- "Contributed" (`data-enrich-work` with `data-status="contributed"`)
- "Skip" (`data-enrich-work` with `data-status="skipped"`)

Calls `contributeEnrichment(id, role, status)` via `runMutation()`.

### Review orchestration
Shows current reviewers with their status (pending/approved/changes-requested) as badges.

**Assign reviewer form** (`data-reviewer-add="id"`): Text input with agent datalist. Calls `assignReviewer(id, reviewerAgentId)`.

**Review actions** (only during `review` phase for `pending` reviewers):
- "Approve [agentId]" button (`data-submit-review` with `data-status="approved"`)
- "Request changes" button (`data-submit-review` with `data-status="changes-requested"`)

Calls `submitReview(id, reviewerAgentId, status)`.

### Dependency manager
Shows current blockers as a list with "Remove" buttons (`data-remove-dependency="id" data-blocked-by="blockerId"`). Calls `removeWorkDependency()`.

**Add blocker form** (`data-work-dependency-add="id"`): A `<select>` dropdown listing all other work articles not already linked as blockers. Calls `addWorkDependency(id, blockedById)`.

### Phase history
At the bottom, a compact phase history timeline: "Phases: planning → enrichment → implementation" showing the progression path.

### Delete
"Delete" button with `window.confirm()` dialog. Calls `deleteWork(id)` with `preferredId = null`.

## Snapshot drift band

Expanded work cards can include a **snapshot-drift band** comparing a baseline environment snapshot to the current sandbox — helping agents notice when their working context has shifted since the work was shaped.

**When it appears**: Only on expanded cards whose phase is in `DRIFT_PHASES` (a `Set` of `"implementation"` and `"review"`). `buildSnapshotDriftPlaceholder(article)` returns `""` for any other phase, so no placeholder is rendered.

**Placeholder + hydration**: During server-side-style render, the expanded card embeds a placeholder `<div class="mt-16 snapshot-drift" data-snapshot-diff="<workId>"></div>` right after the edit form and before the enrichment panel. After every `rerender()`, `hydrateSnapshotDrift()` walks `container.querySelectorAll("[data-snapshot-diff]")` and fetches the diff for each work id.

**API call**: `getWorkSnapshotDiff(id)` hits `GET /api/work/:id/snapshot-diff` and returns `{ current, baseline, diff }`. While the request is in flight the placeholder shows "Checking snapshot drift…".

**Render states** (`renderSnapshotDriftBand(payload)`):
- **No payload / only-one-snapshot** (`!payload.baseline || !payload.diff`): outline notice — "Only one snapshot on record for this work article; nothing to diff against · captured <timeAgo>".
- **No changes**: success notice — "Current sandbox matches the baseline recorded for this work article".
- **Changes detected**: warning notice listing which fields drifted — any of `cwd`, `branch`, `sha`, `dirty`, `package managers`, `runtimes (<names>)`, `lockfiles (<paths>)` — plus an "Baseline → current: N min" age-delta line computed from `diff.ageDeltaSeconds`.
- **404 from API**: the placeholder is cleared (`innerHTML = ""`) and the null payload is cached so the work article renders with no drift band at all.
- **Other errors**: muted "Snapshot drift unavailable." fallback.

**Caching**: A per-page-instance `snapshotDiffCache = new Map()` memoises responses by work id so that collapsing and re-expanding a card (or switching filters) does not re-fetch. The cache is cleared inside `runMutation()` after any successful mutation so the next render sees fresh drift data. 404 responses are cached as `null` to suppress the band entirely on subsequent renders.

## Stat cards (top section)

Four stat cards provide at-a-glance metrics:
- **Ready wave**: Count from `wave.summary.readyCount`, badge "advance now" or "waiting"
- **Blocked**: Count of articles with blockedBy, badge "dependency action" or "clear"
- **Pending reviews**: Articles with any reviewer in pending status, badge "review queue" or "clear"
- **Unassigned impl**: Articles in implementation phase without assignee, badge "assign owners" or "covered"

## Hero callout

Contextual guidance that changes based on `showCreate`:
- When creating: "Capture the work clearly before it spreads across agents"
- When operating: "Use Work to tighten contracts and move execution safely"

Shows article count, ready count, and pending review count as meta badges.

## Key interaction flows

### Creating work
1. Form visible by default (`showCreate = true`)
2. Fill fields (author datalist helps with agent IDs)
3. Submit → creates article, refreshes, form resets

### Advancing lifecycle
1. Filter to ready items or find article in queue
2. Expand card → click "Move to [next phase]"
3. Mutation advances phase, card updates with new phase badge

### Managing reviews
1. Expand article card
2. Assign reviewer via form
3. During review phase, approve or request changes for pending reviewers
4. All reviewers approved → article becomes ready to advance to done

### Managing dependencies
1. Expand article card
2. Use dropdown to select a blocker article → "Add blocker"
3. Blocked badge appears on the card
4. Remove blockers to unblock the article

### Filtering workflow
1. Use toolbar dropdowns to narrow by phase/priority/state
2. Combine with text search for precise filtering
3. "Showing X of Y" counter updates
4. Switch between queue/board/list views to see filtered results differently
