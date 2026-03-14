# Command Center Dashboard Redesign

## Summary

Rewrite `src/dashboard/html.ts` from a 9-tab layout to a sidebar-navigated Command Center. Backend (`server.ts`, `api.ts`, `events.ts`) stays untouched. All 18+ API endpoints remain the same.

## Design Source

10 screens designed and validated in `pencil-new.pen`. This spec maps those mockups to implementation.

## Architecture

### What Changes
- **`src/dashboard/html.ts`** — full rewrite of `renderDashboard()` return value (HTML + CSS + JS)

### What Stays
- `server.ts` — no changes (routing, SSE, mutations, validation)
- `api.ts` — no changes (all data handlers)
- `events.ts` — no changes (event types)
- Function signature: `export function renderDashboard(): string` — unchanged
- All API endpoints consumed by frontend — unchanged

### New CSS System

| Token | Old Value | New Value |
|-------|-----------|-----------|
| `--bg` | `#0a0e14` | `#0C0C0C` |
| `--surface` | `#111820` | `#111111` |
| `--sidebar` | (none) | `#080808` |
| `--border` | `#1c2433` | `#2f2f2f` |
| `--text` | `#e6edf3` | `#ffffff` |
| `--text2` | `#7d8b9d` | `#8a8a8a` |
| `--text3` | `#4a5567` | `#6a6a6a` |
| `--accent` | (blue) | `#00FF88` |
| `--blue` | `#3b82f6` | `#4488FF` |
| `--green` | `#22c55e` | `#00FF88` |
| `--orange` | `#f59e0b` | `#FF8800` |
| `--red` | `#ef4444` | `#FF4444` |
| `--purple` | `#a855f7` | `#8844FF` |
| Font | Inter, system-ui | JetBrains Mono, monospace |

### Layout: Tab Bar → Sidebar Navigation

**Old**: Header bar → stat cards → presence → charts → tab bar → 9 sections
**New**: Fixed sidebar (240px) + scrollable main content area

```
┌──────────┬─────────────────────────────────────┐
│ SIDEBAR  │  MAIN CONTENT                       │
│ 240px    │  (scrollable, per-route)             │
│          │                                      │
│ Logo     │  Route content rendered here:        │
│ Nav      │  - Mission Control                   │
│  items   │  - Agents                            │
│          │  - Tickets                            │
│          │  - Knowledge                          │
│          │  - Workflows                          │
│ ──────── │  - Settings (placeholder)             │
│ Live Feed│                                      │
└──────────┴─────────────────────────────────────┘
```

### Navigation Routes

| Route ID | Label | Icon (lucide) | API Endpoints Used |
|----------|-------|---------------|-------------------|
| `mission` | MISSION CONTROL | `monitor` | overview, presence, tickets/metrics, logs, settings/governance |
| `agents` | AGENTS | `layout-grid` | agents, agent-timeline, presence |
| `tickets` | TICKETS | `ticket` | tickets, tickets/{id}, tickets/metrics, ticket-templates, presence |
| `knowledge` | KNOWLEDGE | `brain` | knowledge, knowledge-graph |
| `workflows` | WORKFLOWS | `git-branch` | (new: reads .agora/workflows/*.yaml via new endpoint or static) |
| `settings` | SETTINGS | `settings` | settings/governance |

### Screen Mapping to API Calls

**Mission Control** — the default landing screen:
- `api('overview')` → stat cards (agents, tickets, reviews, consensus)
- `api('presence')` → agent presence cards with online/idle/offline status
- `api('tickets/metrics')` → status distribution bar, severity breakdown, aging heatmap
- `api('logs?limit=50')` → recent activity feed (used in sidebar live feed)
- `api('settings/governance')` → governance toggle controls

**Agents**:
- `api('agents')` → agent cards grid (left panel)
- `api('agent-timeline')` → detail panel timeline (right panel)
- `api('presence')` → online/idle/offline status indicators

**Tickets**:
- `api('tickets')` → kanban board / table view
- `api('tickets/{id}')` → ticket detail popup (modal overlay)
- `api('tickets/metrics')` → filter bar metadata
- `api('ticket-templates')` → create ticket form templates
- `api('presence')` → session selector for acting-as

**Knowledge**:
- `api('knowledge')` → search results (with query/scope/type/limit params)
- `api('knowledge-graph')` → knowledge graph visualization

**Workflows** (new screen, data from config files):
- Reads workflow YAML configs — either via new API endpoint or embedded from server render
- Shows pipeline visualization of workflow steps

### SSE Integration

Same event types, same connection pattern. Changes:
- SSE pulse moves to sidebar header (logo area)
- Events trigger selective refresh (not full refresh):
  - `ticket_*` events → refresh tickets + mission control metrics
  - `agent_*` / `session_*` → refresh agents + presence
  - `knowledge_*` → refresh knowledge
  - `event_logged` → refresh activity log + live feed
- Live feed in sidebar bottom shows last 4 events from SSE stream

### JavaScript Architecture

**Router** — simple hash-based or state-based routing:
```javascript
let currentRoute = 'mission';
function navigate(route) {
  currentRoute = route;
  updateSidebarActive();
  renderRoute();
}
```

**State** — same global variables as current, plus:
```javascript
let currentRoute = 'mission';
let liveFeedEvents = [];  // last 4 SSE events for sidebar
let selectedAgentId = null;  // agents view detail panel
```

**Preserved functions** (reused or adapted):
- `api()`, `apiPost()`, `esc()` — unchanged
- `makeDonut()`, `makeBarChart()`, `makeSparkline()` — adapted to new colors
- `filterTicketList()`, `ticketAssigneeOptions()` — unchanged
- `renderTicketDetail()` — adapted to modal overlay
- `renderGovernancePanel()` — moved to Mission Control
- Canvas-based knowledge graph — preserved
- All ticket CRUD operations — unchanged
- Comment rendering, quorum display — adapted to new styling

### Ticket Detail: Tab Section → Modal Overlay

Current: clicking a ticket shows detail in a side panel within the tickets section.
New: clicking a ticket opens a centered modal overlay (700px wide) with:
- Header: ticket ID + status badge + severity + ADVANCE STATUS button
- Description + plan with checkboxes
- Comments with agent personas
- Right panel: council verdicts (6 specializations)
- Close on X button or backdrop click

### Create Ticket: Inline Form → Modal Overlay

Current: form embedded in tickets toolbar.
New: modal overlay (700px wide) triggered by "+ CREATE" button, with:
- Template selector dropdown
- Author mode toggle (AGENT / HUMAN)
- All form fields (title, description, severity, priority, tags, paths, criteria)

### New Feature: Workflows View

No existing API endpoint. Options:
1. Add `GET /api/workflows` endpoint to `server.ts` that reads `.agora/workflows/*.yaml`
2. Embed workflow config at render time in `renderDashboard()` function

Recommend option 1 for consistency. This is the ONE backend addition.

### Fonts

JetBrains Mono is loaded via Google Fonts link in `<head>`:
```html
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Fallback: `monospace` for offline/restricted environments.

## Implementation Phases

1. **Shell** — CSS system, sidebar, router, live feed
2. **Mission Control** — stats, presence, governance, charts, metrics
3. **Tickets** — kanban, table, detail modal, create modal, filters
4. **Agents** — cards grid, detail panel, timeline
5. **Knowledge** — search, results, graph canvas
6. **Workflows** — API endpoint + pipeline visualization
7. **Activity Log + Metrics** — event table, dependency graph, sparkline charts
8. **Polish** — SSE selective refresh, transitions, responsive fallbacks

## Testing Strategy

- Manual: open dashboard, navigate all routes, verify data loads
- SSE: verify live updates propagate to correct screens
- Mutations: create ticket, comment, assign, transition — verify toasts and refresh
- Edge cases: empty states, no agents, no tickets, SSE disconnect/reconnect
