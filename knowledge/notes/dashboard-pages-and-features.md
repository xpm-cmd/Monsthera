---
id: k-jgazhhz6
title: Dashboard pages and features
slug: dashboard-pages-and-features
category: guide
tags: [dashboard, frontend, pages, features, guide]
codeRefs: [public/pages/overview.js, public/pages/knowledge.js, public/pages/knowledge-graph.js, public/pages/work.js, public/pages/search.js, public/pages/flow.js, public/pages/guide.js, public/pages/security.js, public/pages/system/health.js, public/pages/system/models.js, public/pages/system/agents.js, public/pages/system/integrations.js, public/pages/system/storage.js, public/lib/guide-data.js]
references: []
createdAt: 2026-04-11T02:19:30.612Z
updatedAt: 2026-04-11T02:19:30.612Z
---

# Dashboard Pages and Features

## Page Module Contract

Every page module exports an async `render(container, params)` function. `container` is the `#content` DOM element. Pages fetch data from `public/lib/api.js`, build HTML strings using components from `public/lib/components.js`, and inject via `innerHTML` or `template.content`. Pages may return a cleanup function (or `{ cleanup }` object) called on navigation away.

Many pages implement a **refresh/re-render** pattern: data is fetched into top-level variables, a `rerender()` function rebuilds the DOM, and event handlers call `refresh()` (re-fetch) then `rerender()`. This enables in-place updates without full page reloads.

---

## Core Pages

### Overview (`public/pages/overview.js`)
**Route:** `/`

The dashboard home page. Fetches health, work articles, knowledge articles, orchestration wave, runtime status, and agent directory in parallel. Displays:
- **Hero callout** with system name, health status badge, and summary stats (articles, work items, agents)
- **Stat cards** for knowledge count, work count, active agents, and wave readiness
- **Start Here section** showing the first 3 onboarding steps from `guide-data.js`
- **Orchestration alert** with ready/blocked wave counts and an "Execute wave" button
- **Agent experience recommendations** (if available from runtime) as actionable cards

Uses `renderHeroCallout`, `renderStatCard`, `renderAlert`, `renderBadge`.

### Knowledge (`public/pages/knowledge.js`)
**Route:** `/knowledge`

Full CRUD interface for knowledge articles. Features:
- **Search input** for filtering articles by title
- **Category filter** via badge chips
- **Article list** showing title, category badge, tags, code refs, and relative timestamp
- **Inline editor** for creating new articles (title, category, tags, code refs, content textarea)
- **Edit mode** for existing articles with pre-populated fields
- **Delete** with confirmation
- **Local import form** for ingesting `.md`/`.txt` files from the workspace via `ingestLocalKnowledge()`
- **Backlinks section** cross-referencing work articles that reference a knowledge article
- **Markdown preview** for article content via `renderMarkdown()`

Fetches both knowledge and work articles to compute backlinks.

### Knowledge Graph (`public/pages/knowledge-graph.js`)
**Route:** `/knowledge/graph`

Interactive graph visualization using **Cytoscape.js** (loaded lazily from CDN). Renders the structure graph from `GET /api/structure/graph`:
- Nodes represent knowledge articles, work articles, and code references
- Edges show relationships (references, shared tags, code refs)
- Color-coded by node type: knowledge (purple), work (green), code (gray)
- **Search/filter** input to highlight matching nodes
- **Tab navigation** between graph view and a tabular node list
- Reads CSS custom properties for theme-aware node/edge colors
- Node labels are truncated to 42 characters

### Work (`public/pages/work.js`)
**Route:** `/work`

Complete work management interface with lifecycle controls:
- **Hero callout** with work stats and orchestration wave summary
- **Phase tabs** to filter by lifecycle phase (planning, enrichment, implementation, review, done)
- **Filter presets**: All work, Ready wave, Blocked, Needs review, Unassigned impl
- **Work table** with columns: title, template, phase badge, priority badge, assignee, updated time
- **Detail panel** for selected work item showing full content, dependencies, reviewers
- **Create form** for new work items (title, template, priority, author, assignee, content)
- **Phase advancement** via button (planning → enrichment → implementation → review → done)
- **Enrichment contribution**: Mark roles as "contributed" or "skipped"
- **Reviewer assignment** with agent selection dropdown
- **Review submission**: Approve or request changes
- **Dependency management**: Add/remove blockedBy links to other work items
- **Delete** with confirmation

The phase lifecycle follows: planning → enrichment → implementation → review → done.

### Search (`public/pages/search.js`)
**Route:** `/search`

Search interface with context pack support:
- **Search input** with debounced query
- **Mode selector**: Code mode, Research mode, General mode — each with a guide explaining when to use it
- **Type filter**: All, Knowledge only, Work only
- **Results list** with type badges (knowledge=primary, work=success), freshness indicators (fresh/attention/stale), scores, and snippets
- **Context pack view**: Shows ranked results with quality scores, guidance text, and freshness diagnostics
- **Mode-specific guides** rendered as hero callouts explaining the search workflow

### Flow (`public/pages/flow.js`)
**Route:** `/flow`

Orchestration control center showing wave status and agent readiness:
- **Hero callout** with orchestration status (running/stopped, auto-advance on/off)
- **Stat cards**: Ready items, blocked items, active agents, total work
- **Phase chip bar** to filter work by phase
- **Ready wave table**: Work items ready for phase advancement with from/to phase, priority, assignee
- **Blocked items table**: Items that cannot advance, with blocking reason
- **Execute wave button**: Triggers `POST /api/orchestration/wave/execute` and shows results (advanced/failed/blocked counts)
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

### Security (`public/pages/security.js`)
**Route:** `/security`

Security posture dashboard:
- **Tabs**: Posture, Audit trail
- **Posture tab**: Security score (0-100) derived from local-first storage, review gates, automation settings. Shows policy cards for storage, review gate, and automation mode. Lists external endpoints.
- **Audit trail tab**: Recent orchestration events with type badges (phase_advanced, dependency_blocked, error_occurred, etc.), timestamps, and details.
- Fetches data from `GET /api/system/runtime` (security and orchestration sections).

---

## System Pages (under `/system`)

### Health (`public/pages/system/health.js`)
**Route:** `/system`

System health overview:
- Fetches from `/api/health` and `/api/status`
- **Subsystem cards**: Each subsystem shown with name, healthy/unhealthy badge, and detail text
- **Stats table**: Knowledge article count, work article count, search index size, last reindex time, last migration time
- Displays version and uptime

### Models & Runtime (`public/pages/system/models.js`)
**Route:** `/system/models`

Provider and model configuration display:
- **Embedding provider card**: Provider name, model, semantic search status badge
- **Model endpoint card**: Ollama URL, blend alpha value
- **Orchestration runtime card**: Auto-advance status, poll interval, max concurrent agents, running state

### Agent Profiles (`public/pages/system/agents.js`)
**Route:** `/system/agents`

Agent directory and detail view:
- **Agent list** with selection (click to view details)
- **Agent detail panel**: Shows agent ID, status (active/idle), work count, pending review count
- **Agent experience scores** and recommendations from runtime API
- **Agent tooling playbook** and usage principles from guide-data.js
- **Continuous improvement loop** documentation

### Integrations (`public/pages/system/integrations.js`)
**Route:** `/system/integrations`

Connected services overview:
- **Integration cards** for each service (Markdown repo, Dolt, Ollama, local ingest, search auto-sync, MCP server) with configured/disabled and healthy/unavailable badges
- **Capability matrix**: Table of all system capabilities with enabled/disabled status

### Storage & Indexing (`public/pages/system/storage.js`)
**Route:** `/system/storage`

Storage backend and search index management:
- Fetches status, knowledge, and work article lists
- **Storage info**: Mode (markdown-only or markdown+dolt), paths, database config
- **Index stats**: Article counts, index size
- **Reindex button**: Triggers `POST /api/search/reindex` and shows results (count of reindexed items)
- **Flash messages** for operation feedback
- Supports refresh/re-render pattern for live updates after reindex
