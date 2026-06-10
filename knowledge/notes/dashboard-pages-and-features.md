---
id: k-jgazhhz6
title: Dashboard pages and features
slug: dashboard-pages-and-features
category: guide
tags: [dashboard, frontend, pages, features, guide]
codeRefs: [public/pages/overview.js, public/pages/knowledge.js, public/pages/knowledge-graph.js, public/pages/work.js, public/pages/search.js, public/pages/flow.js, public/pages/guide.js, public/pages/security.js, public/pages/system/health.js, public/pages/system/models.js, public/pages/system/agents.js, public/pages/system/integrations.js, public/pages/system/storage.js, public/lib/guide-data.js]
references: []
createdAt: 2026-04-11T02:19:30.612Z
updatedAt: 2026-06-10T23:21:07.469Z
---

# Dashboard Pages and Features

## Page Module Contract

Every page module exports an async `render(container, params)` function. `container` is the `#content` DOM element. Pages fetch data from `public/lib/api.js`, build HTML strings using components from `public/lib/components.js`, and inject via `innerHTML` or `template.content`. Pages may return a cleanup function (or `{ cleanup }` object) called on navigation away.

Many pages implement a **refresh/re-render** pattern: data is fetched into top-level variables, a `rerender()` function rebuilds the DOM, and event handlers call `refresh()` (re-fetch) then `rerender()`. This enables in-place updates without full page reloads.

**Collapsible hero callouts**: the didactic hero sections on Flow, Knowledge, Work, Search, and Sessions pass a `collapseKey` to `renderHeroCallout`, which adds a Hide / "Show guide" toggle. The collapsed state persists per page in `localStorage` as `monsthera-hero-<key>` (handled globally in `app.js`). Overview's dynamic next-best-action hero has no collapse key and always renders fully.

---

## Core Pages

### Overview (`public/pages/overview.js`)
**Route:** `/`

The dashboard home page. Fetches health, work articles, knowledge articles, orchestration wave, runtime status, agent directory, and convoys in parallel. Displays:
- **"Next best action" hero callout** that adapts to state: advance the ready wave, unblock constrained work, or shape the next work contract
- **Orchestration alert** with ready count and an "Advance ready wave" button (`data-run-wave`)
- **Start Here section** showing the first 3 onboarding steps from `guide-data.js`
- **Agent-directory empty state** card with CTAs when no agents are registered yet
- **Needs attention** bullet list (ready, blocked, pending-review, unassigned-impl items)
- **Latest knowledge** card with the most recently updated article
- **Stat cards** in the side column: ready wave, blocked articles, convoys (active count), agents, automation mode, plus a system-health tile

Uses `renderHeroCallout`, `renderStatCard`, `renderAlert`, `renderBadge`.

### Knowledge (`public/pages/knowledge.js`)
**Route:** `/knowledge`

Full CRUD interface for knowledge articles. Features:
- **Search input** for filtering articles by title/category/tags
- **Category-grouped article list** with freshness badges
- **Inline editor** for creating new articles (title, category, tags, code refs, content textarea) with a **live slug preview** backed by `POST /api/knowledge/preview-slug`
- **Edit mode** for existing articles with pre-populated fields
- **Rename slug form** (atomic reference updates, optional `[[wikilink]]` rewrite)
- **Bulk import (JSON)** form against the `POST/PATCH /api/knowledge/batch` endpoints (up to 100 entries, per-entry results)
- **Delete** with confirmation
- **Local import form** for ingesting `.md`/`.txt` files from the workspace via `ingestLocalKnowledge()`
- **Backlinks section** cross-referencing work articles that reference a knowledge article
- **Markdown preview** for article content via `renderMarkdown()`

Fetches both knowledge and work articles to compute backlinks.

### Knowledge Graph (`public/pages/knowledge-graph.js`)
**Route:** `/knowledge/graph`

Interactive graph visualization using **Cytoscape.js** (loaded lazily from the self-hosted bundle `/vendor/cytoscape.min.js` — no CDN). Renders the structure graph from `GET /api/structure/graph`:
- Nodes represent knowledge articles (ellipses), work articles (round rectangles), and code refs (rectangles; missing files get a distinct error tint)
- Edges show relationships: references, dependencies, code refs, and optional shared-tag links (dashed, toggleable)
- **Presets** (Articles / Mixed / Code) plus per-kind filter chips control which node types are visible
- **Find & focus**: a search input with a datalist focuses a node and isolates its immediate neighborhood; clicking a node does the same
- **Toggles** for node labels and shared-tag links; zoom/fit/organize controls
- **Summary cards** for knowledge/work/code counts and structural gaps (missing refs, deps, code)
- **Node detail panel** with metadata, preview, path, tags, and direct connections
- Reads CSS custom properties for theme-aware colors; node labels are truncated (~42 chars, shorter for code nodes)

### Work (`public/pages/work.js`)
**Route:** `/work`

Complete work management interface with lifecycle controls:
- **Collapsible hero callout** (`collapseKey: "work"`) with article/ready/pending-review meta badges
- **Stat cards**: Ready wave, Blocked, Pending reviews, Unassigned impl
- **Filter toolbar**: free-text search + phase / priority / state dropdowns (All work, Ready wave, Blocked, Needs review, Unassigned impl)
- **Three view modes** (Queue / Board / List); board and list entries carry `data-open-work` buttons that jump back to the queue view with that card expanded
- **Work cards** with phase/priority/ready/blocked badges and a dedicated expand toggle
- **Create form** for new work items (title, author, lead, template, priority, assignee, tags, references, code refs, content)
- **Phase advancement** via button (planning → enrichment → implementation → review → done), with a guard-failure prompt that retries with `skipGuard`
- **Override guards / Cancel** actions with prompted, audited reasons
- **Enrichment contribution**: Mark roles as "contributed" or "skipped"
- **Reviewer assignment** with agent datalist autocomplete
- **Review submission**: Approve or request changes
- **Dependency management**: Add/remove blockedBy links to other work items
- **Convoy ribbon** on expanded cards when the article leads convoys (pills link to `/convoys/:id`)
- **Snapshot-drift band** on expanded implementation/review cards (see the work-page UX note)
- **Delete** with confirmation

The phase lifecycle follows: planning → enrichment → implementation → review → done (plus cancel to `cancelled`).

### Search (`public/pages/search.js`)
**Route:** `/search`

Search interface with context pack support:
- **Search input** with debounced query (250ms)
- **Mode selector**: Code generation, Investigation, General
- **Type filter**: All, Knowledge only, Work only
- **Results-first layout**: with an active query the ranked results render immediately under the filters with a preview side panel; the pack summary card moves below the results
- **Mode guide hero** (collapsible, `collapseKey: "search"`): the didactic mode explanation only renders in the empty state — it no longer pushes live results below the fold
- **Results list** with type badges (knowledge=primary, work=success), freshness indicators (fresh/attention/stale), quality labels, reasons, and snippets
- **Context pack summary card**: item/fresh/code-linked/index-drift stat tiles plus guidance bullets
- **Result preview panel**: click a result to fetch and preview the full article

### Flow (`public/pages/flow.js`)
**Route:** `/flow`

Orchestration control center showing wave status and agent readiness:
- **Collapsible hero callout** (`collapseKey: "flow"`) with ready/blocked meta badges
- **Stat cards**: Ready wave, blocked, active agents, automation mode
- **Phase chip bar** to filter the agent table by phase
- **Agent table**: current action, active article, signals (pending reviews, blocked work, idle), last activity
- **Ready to advance / Blocked work cards** with per-item reasons
- **Execute wave button**: Triggers `POST /api/orchestration/wave/execute` and shows results
- **Flash messages** for success/error feedback
- **Phase playbooks** from `guide-data.js` showing what each phase means

### Guide (`public/pages/guide.js`)
**Route:** `/guide`

Comprehensive onboarding and reference guide:
- **Onboarding steps** as clickable cards with CTAs linking to relevant pages
- **Operation modes**: Descriptions of how the system operates
- **Benefit pillars**: Core value propositions
- **Dashboard sections**: Map of what each page does
- **Operator journeys**: Common workflows
- **Phase playbooks**: Detailed guide for each work phase
- **Agent tooling playbook**: How agents should use the system
- **Agent usage principles**: Best practices
- **Continuous improvement loop**: Feedback cycle documentation
- **Automation rules**: What's automated vs. manual
- **Agent experience recommendations** (live from runtime API)

All guide content is sourced from `public/lib/guide-data.js`.

### Events (`public/pages/events.js`)
**Route:** `/events`

Read-only orchestration event stream (ADR-008 agent-dispatch surface):
- Lists recent events from `GET /api/events` (limit 200), **auto-refreshing every 5s**
- **Type filter** dropdown (agent_needed, agent_started, agent_completed, agent_failed, phase_advanced, guard_evaluated, error_occurred) plus manual refresh
- Each row shows the event type badge, role, phase transition, reason/trigger, work/agent ids, error messages, and an expandable context-pack guidance list
- Emitting events stays with the CLI/MCP (`monsthera events emit`, `events_emit`, `POST /api/events/emit`)

### Convoys (`public/pages/convoys.js` + `public/pages/convoy.js`)
**Routes:** `/convoys`, `/convoys/:id`

Read-only view of grouped work articles:
- The list page shows **unresolved lead-cancellation warnings**, active convoy cards (lead, phase distribution chips, goal), and recent terminal convoys
- The detail page shows the convoy header (goal, lead, target phase, status, guard passing/blocked state, warning notice), the member list with phase chips, recent lead activity, and the convoy lifecycle log
- Convoy creation/cancellation stays with the CLI/MCP; the sidebar's Convoys nav item carries a warning-count badge

### Code (`public/pages/code.js`)
**Route:** `/code`

Code-ref intelligence (ADR-015 Layer 1) over the operational corpus:
- **Inspect a single path**: full impact analysis — existence, owners, active work, policies, risk level, reasons, recommended next actions (backed by `GET /api/code/impact`)
- **Detect changes across a diff**: paste paths one per line (e.g. from `git diff --name-only`), submit to `POST /api/code/changes`, and see impacts grouped by risk
- Builds DOM via `Range.createContextualFragment` rather than `innerHTML` for API-derived markup

### Sessions (`public/pages/sessions.js`)
**Route:** `/sessions`

Read-only surface for the cognitive-handoff session lifecycle (opening/closing sessions stays with the CLI/MCP):
- **Collapsible hero callout** (`collapseKey: "sessions"`) explaining open → work → close-with-handoff
- **Session list** from `GET /api/sessions` (newest first): status badge (open/closed/abandoned), session id, agent, open/close times, branch, intent
- **Detail panel** from `GET /api/sessions/:id`: agent, repo, branch, timestamps, handoff article id (with a pointer to Knowledge), quality score, abandon reason

### Security (`public/pages/security.js`)
**Route:** `/security`

Security posture dashboard with three tabs:
- **Policy & Posture**: Security score (0-100) derived from local-first storage, review gates, automation settings. Shows policy cards for storage, review gate, and automation mode. Lists external endpoints.
- **Dashboard Permissions**: capability matrix (knowledge/work CRUD, phase advance, review workflow, ingest, reindex, context packs, wave planning/execution, migration) plus a boundary summary
- **Audit Trail**: Recent orchestration events with type badges (phase_advanced, dependency_blocked, error_occurred, etc.), timestamps, and details.
- Fetches data from `GET /api/system/runtime` (security, capabilities, and orchestration sections).

---

## System Pages (under `/system`)

### Health (`public/pages/system/health.js`)
**Route:** `/system`

System health overview:
- Fetches from `/api/health`, `/api/status`, and `/api/system/eval`
- **Subsystem cards**: Each subsystem shown with name, healthy/unhealthy badge, and detail text
- **Stats table**: Knowledge article count, work article count, search index size, last reindex time, last migration time
- **Retrieval quality card**: renders the committed eval baseline from `GET /api/system/eval` — engine badge (semantic vs bm25), live semantic state, golden-case count, and NDCG@k / MRR / Recall / Contamination metric tiles. The endpoint 404s in consumer repos without `tests/eval/baseline.json`, in which case the card is hidden.

### Models & Runtime (`public/pages/system/models.js`)
**Route:** `/system/models`

Provider and model configuration display:
- **Embedding provider card**: Provider name, model, semantic search status badge
- **Model endpoint card**: Ollama URL, blend alpha value
- **Orchestration runtime card**: Auto-advance status, poll interval, max concurrent agents, running state

### Agent Profiles (`public/pages/system/agents.js`)
**Route:** `/system/agents`

Agent directory and detail view:
- **Summary stat cards**: total agents, active, reviewers waiting, enrichment waiting
- **Agent experience scores** (readiness/context/ownership/review coverage) and optimization recommendations from the runtime API
- **Agent list** with selection (click to view details)
- **Agent detail panel**: stat grid (active work, pending review, assigned, enrichment), current focus, recent events, associated work table
- **Agent tooling playbook**, usage principles, and continuous improvement loop from guide-data.js

### Integrations (`public/pages/system/integrations.js`)
**Route:** `/system/integrations`

Connected services overview:
- **Integration cards** for each service (Markdown repo, Dolt, Ollama, local ingest, search auto-sync, MCP server) with configured/disabled and healthy/unavailable badges
- **Capability matrix**: Table of all system capabilities with enabled/disabled status

### Storage & Indexing (`public/pages/system/storage.js`)
**Route:** `/system/storage`

Storage backend and search index management:
- Fetches status, knowledge, and work article lists
- **Storage info**: backend detail (markdown-only or markdown+dolt)
- **Index stats**: Article counts, index size, last reindex/migration
- **Reindex button**: Triggers `POST /api/search/reindex` and shows results (count of reindexed items)
- **Flash messages** for operation feedback
- Supports refresh/re-render pattern for live updates after reindex