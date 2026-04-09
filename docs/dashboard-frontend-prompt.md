# Monsthera v3 Dashboard Frontend — Implementation Prompt

## What you're building

A browser-based dashboard frontend for **Monsthera v3**, a knowledge-native development platform for AI coding agents. The backend API already exists and serves JSON over HTTP. You need to build the frontend that consumes it.

The dashboard has 5 redesigned screens (v2) with approved mockups, plus 7 screens that keep the v1 design but share the same sidebar and layout system. All screens have been designed in both light and dark mode.

## Repository

- **Repo path:** `/Users/xpm/Projects/Github/Monsthera`
- **Branch:** `rewrite/v3`
- **Package manager:** pnpm
- **Node version:** >=22
- **Existing backend:** `src/dashboard/index.ts` — HTTP JSON API server
- **Start command:** `pnpm run dev` (runs `tsx watch src/bin.ts serve`)
- **Default port:** 3000 (configurable via `MONSTHERA_PORT`)

## Design mockups

The v2 mockups are in `docs/claude-review/assets/v2/`. Read each image file to see the design:

| Screen | Dark mode | Light mode |
|---|---|---|
| Overview | `docs/claude-review/assets/v2/zs47R.webp` | `docs/claude-review/assets/v2/Igo7t.webp` |
| Flow | `docs/claude-review/assets/v2/PE1fZ.webp` | `docs/claude-review/assets/v2/uaBjs.webp` |
| Knowledge | `docs/claude-review/assets/v2/byCV9.webp` | `docs/claude-review/assets/v2/2zPZc.webp` |
| Knowledge Graph | `docs/claude-review/assets/v2/JssNL.webp` | `docs/claude-review/assets/v2/9rEyn.webp` |
| Security | `docs/claude-review/assets/v2/x79BN.webp` | `docs/claude-review/assets/v2/7O2gs.webp` |

Read these images before writing any code. They are the source of truth for the visual design.

## Tech stack decision

The frontend should be a **single-page app served by the existing Node.js dashboard server**. Choose one of:
- **Option A (recommended):** Plain HTML + CSS + vanilla JS with no build step. Serve static files from a `public/` directory added to the existing dashboard server. Best for speed and zero dependencies.
- **Option B:** If the design complexity warrants it, use a minimal framework (Preact + HTM, no JSX transpilation needed). Still served from `public/`.

Do NOT use React, Next.js, Vite, or any heavy framework. The dashboard is a thin surface over an API — keep it lightweight.

## Design system tokens

These are the exact CSS custom properties. Use them everywhere — no hardcoded colors.

```css
:root {
  /* Light mode */
  --background: #FFFFFF;
  --card: #FFFFFF;
  --tile: #F5F5F5;
  --foreground: #2A2933;
  --muted-foreground: #616167;
  --primary: #5749F4;
  --primary-foreground: #FFFFFF;
  --border: #C5C5CB;
  --sidebar: #FFFFFF;
  --sidebar-foreground: #939399;
  --sidebar-primary: #F5F5F5;
  --sidebar-primary-foreground: #2A2933;
  --sidebar-border: #D9D9DB;
  --secondary: #D9D9DB;
  --secondary-foreground: #2A2933;
  --color-success: #A1E5A1;
  --color-success-fg: #003300;
  --color-warning: #FFD9B2;
  --color-warning-fg: #4D2700;
  --color-error: #FFBFB2;
  --color-error-fg: #590F00;
  --input: #C5C5CB;
  --radius-m: 16px;
  --radius-l: 24px;
  --radius-pill: 999px;
  --radius-xs: 6px;
}

[data-theme="dark"] {
  --background: #131124;
  --card: #1A182E;
  --tile: #1A182E;
  --foreground: #F1F0F7;
  --muted-foreground: #A6A5B8;
  --primary: #A89BFF;
  --primary-foreground: #131124;
  --border: #2B283D;
  --sidebar: #1A182E;
  --sidebar-foreground: #C2C1CE;
  --sidebar-primary: #3B3760;
  --sidebar-primary-foreground: #F7F7FA;
  --sidebar-border: #2B283D;
  --secondary: #4C4866;
  --secondary-foreground: #F7F7FA;
  --color-success: #3B4748;
  --color-success-fg: #A1E5A1;
  --color-warning: #53484F;
  --color-warning-fg: #FFD9B2;
  --color-error: #53424F;
  --color-error-fg: #FFBFB2;
  --input: #2B283D;
}
```

**Typography:** Inter for all text. Font sizes: 26px titles, 16px body, 14px secondary, 13px captions, 12px labels. Weight 600 for headings, 500 for labels, normal for body.

**Icons:** Use Lucide icons (CDN: `https://unpkg.com/lucide@latest`). Icon names used in mockups: `layout-dashboard`, `activity`, `list-todo`, `book-open`, `search`, `settings`, `leaf`, `zap`, `x`, `file-code`, `plus`, `minus`.

## API endpoints

The backend serves these read-only JSON endpoints at `http://localhost:3000`:

### `GET /api/health`
```json
{
  "healthy": true,
  "version": "3.0.0-alpha.0",
  "uptime": 12345,
  "subsystems": [
    { "name": "knowledge", "healthy": true, "detail": "ok" },
    { "name": "search", "healthy": true, "detail": "indexed" }
  ]
}
```

### `GET /api/status`
```json
{
  "version": "3.0.0-alpha.0",
  "uptime": 12345,
  "timestamp": "2026-04-09T...",
  "subsystems": [...],
  "stats": {
    "knowledgeArticleCount": 12,
    "workArticleCount": 5,
    "searchIndexSize": 17,
    "lastReindexAt": "2026-04-09T...",
    "lastMigrationAt": null
  }
}
```

### `GET /api/knowledge` and `GET /api/knowledge?category=architecture`
```json
[
  {
    "id": "art-001",
    "title": "v3 final architecture",
    "slug": "v3-final-architecture",
    "category": "architecture",
    "content": "markdown content...",
    "tags": ["v3", "architecture"],
    "codeRefs": ["src/core/container.ts"],
    "createdAt": "2026-04-07T...",
    "updatedAt": "2026-04-09T..."
  }
]
```

### `GET /api/knowledge/:id`
Returns a single knowledge article (same shape as above).

### `GET /api/work` and `GET /api/work?phase=implementation`
```json
[
  {
    "id": "WA-0042",
    "title": "API migration contract review",
    "template": "feature",
    "phase": "review",
    "priority": "high",
    "author": "Planner-A",
    "lead": "Planner-A",
    "assignee": "Builder-C",
    "enrichmentRoles": [
      { "role": "architecture", "agentId": "Knowledge-B", "status": "contributed", "contributedAt": "..." }
    ],
    "reviewers": [
      { "agentId": "Reviewer-D", "status": "pending", "reviewedAt": null }
    ],
    "phaseHistory": [
      { "phase": "planning", "enteredAt": "...", "exitedAt": "..." },
      { "phase": "enrichment", "enteredAt": "...", "exitedAt": "..." },
      { "phase": "implementation", "enteredAt": "...", "exitedAt": "..." },
      { "phase": "review", "enteredAt": "...", "exitedAt": null }
    ],
    "tags": ["api", "migration"],
    "references": [],
    "codeRefs": ["src/work/lifecycle.ts"],
    "dependencies": [],
    "blockedBy": [],
    "content": "markdown content...",
    "createdAt": "...",
    "updatedAt": "...",
    "completedAt": null
  }
]
```

### `GET /api/work/:id`
Returns a single work article (same shape as above).

### `GET /api/search?q=migration&limit=10`
```json
[
  {
    "id": "WA-0042",
    "title": "API migration contract review",
    "type": "work",
    "score": 0.95,
    "snippet": "...migration contract and knowledge sync..."
  }
]
```

## Screen specifications

### Shared layout
- **Sidebar (240px):** Left column, full height. Logo ("Monsthera" + leaf icon), 6 nav items (Overview, Flow, Work, Knowledge, Search, System). Active item highlighted with `--sidebar-primary` background. Footer shows "rewrite / v3" and "workspace active".
- **When System is active:** Sub-nav items appear below System: Health, Models & Runtime, Agent Profiles, Integrations, Storage & Indexing, Security. Sub-items are indented (padding-left: 40px) with smaller font (13px).
- **Main area:** Takes remaining width. Padding 28px. Vertical layout with 20px gap.
- **Dark mode default.** Add a theme toggle in the sidebar header.

### 1. Overview (`/`)
**Data sources:** `GET /api/status`, `GET /api/work`, `GET /api/knowledge`

**Layout:** Header + body (left column flexible + right column 280px)

**Left column:**
- Warning alert: "Wave 14: 2 articles ready to advance" with description text. Buttons: "Advance 2 articles" (primary), "Review blockers" (outline).
- "Needs attention" card: bulleted list of specific blockers derived from work articles (agents waiting, idle agents, aging reviews).
- "Latest knowledge" card: count of recent articles, description, "Review notes" button.

**Right column (280px):**
- Stat card: "Active wave" → "Wave 14" with green badge "2 handoffs now"
- Stat card: "Blocked articles" → count with orange badge "1 critical"
- Stat card: "Knowledge freshness" → percentage with green badge "reindexed today"
- "System health" card: summary text + "Open system" button

### 2. Flow (`/flow`)
**Data sources:** `GET /api/work`, `GET /api/status`

**Layout:** Header + wave chip bar + phase tabs + agent activity table

**Wave chip bar:** Horizontal row of pill-shaped chips. Active wave highlighted with `--primary`. Each chip shows: "Wave N: Status" + count badge. Chips are compact (~40px height).

**Phase tabs:** Segmented control with 5 phases: Planning, Enrichment, Implementation, Review, Done. Active tab uses `--secondary` fill. These filter the agent table below.

**Agent activity table:** Full-width card with columns: Agent (140px), Current action (180px, colored badges), Article (flexible, primary color link), Last activity (100px, right-aligned). Rows show each agent's current state. Derive agent activity from work articles (who is assigned, what phase, what article).

### 3. Knowledge (`/knowledge`)
**Data sources:** `GET /api/knowledge`

**Layout:** Header + 3-column body

**Left column (220px):** Article navigator. Search box at top. Below: articles grouped by category (Architecture, Guides, Decisions). Group headers in muted uppercase. Selected article highlighted with `--sidebar-primary`. 

**Center column (flexible):** Article preview. Shows title, category badge, "Updated X ago", markdown content preview, "Read full article" button.

**Right column (260px):** Two cards:
- "Backlinks & related": count of linked work articles, architecture notes, guides, graph neighbors. "Open relations" button.
- "Code references": list of file paths in monospace font (`Geist Mono`), file + symbol count.

**Top right:** Single button "Open Graph →" (navigates to `/knowledge/graph`).

### 4. Knowledge Graph (`/knowledge/graph`)
**Data sources:** `GET /api/knowledge`, `GET /api/work`

**Layout:** Full-width graph canvas with floating controls.

**Top bar (no padding, border-bottom):** Title "Knowledge Graph" + mode toggle (Articles | Mixed | Code) + search box + zoom controls (- | 100% | +) + "Center selected" button.

**Graph canvas:** Use a graph visualization library (d3-force, cytoscape.js, or sigma.js). Nodes represent:
- Knowledge articles: purple border, rounded rect
- Work articles: green border, rounded rect  
- Code files: blue border (#6BA3E8), sharp rect, monospace label
- Orchestration touchpoints: orange border, diamond shape

Edges connect related nodes. Build the graph from `codeRefs`, `references`, `dependencies`, and `tags` relationships in the API data.

**Floating legend (top-left):** Small card with node type legend.

**Right drawer (on-demand):** Appears when a node is clicked. Shows: title, type badge, description/content preview, relationships list, "Open article" button. Dismiss with X.

### 5. Security (`/security`)
**Data sources:** `GET /api/status` (for now, security config is not yet in API — use static placeholder data)

**Layout:** Header + tabs + tab content

**Sidebar:** System is active with sub-nav expanded. "Security" sub-item is highlighted.

**Tabs:** "Policy & Posture" (default) | "Agent Permissions" | "Audit Trail"

**Policy & Posture tab:**
- Posture card: "92 / 100" score prominently displayed, "Local-first execution with least-privilege defaults" description.
- Policy row: 3 cards (Tool policy: "Strict allowlist", Repo access: "Claim before write", Approval mode: "Auto inside policy").
- Right column (320px): "Effective policy" card with checkmark items + "Runtime boundaries" card with sandbox posture and approval strategy.

**Agent Permissions tab and Audit Trail tab:** Placeholder content for now.

### 6-12. Remaining screens (v1 design, lower priority)
- **Work** (`/work`): Queue view with work article cards. Toggle: Queue | Board | List.
- **Search** (`/search`): Search input + results list + right panel with preview and filters.
- **System > Health** (`/system`): Subsystem status cards (Healthy/Warning/Error).
- **System > Models & Runtime** (`/system/models`): Provider, model, routing config.
- **System > Agent Profiles** (`/system/agents`): Agent list + selected profile detail.
- **System > Integrations** (`/system/integrations`): Connected apps, MCP surfaces, webhooks.
- **System > Storage & Indexing** (`/system/storage`): Backend, freshness, indexing policy.

For these screens, look at the v1 mockup images in `docs/claude-review/assets/` for visual reference and implement based on available API data.

## Implementation approach

1. **Start by modifying `src/dashboard/index.ts`** to serve static files from a `public/` directory for any non-`/api/` route. Add a fallback that serves `public/index.html` for SPA routing.

2. **Create `public/index.html`** with the full SPA structure: sidebar, main area, router.

3. **Create `public/styles.css`** with the design tokens and component styles.

4. **Create `public/app.js`** with:
   - Client-side router (hash-based or History API)
   - API client (fetch wrapper for all endpoints)
   - Page renderers for each screen
   - Theme toggle (dark/light, persist to localStorage)

5. **Build screens in order:** Overview → Flow → Knowledge → Search → Work → System screens → Knowledge Graph (most complex, last) → Security.

6. **Start the server** with `pnpm run dev` and verify at `http://localhost:3000`.

## Key design principles from the UX review

- **One dominant question per screen.** Don't cram multiple purposes.
- **Progressive disclosure.** Show essentials first, details on demand.
- **Functional > aspirational.** Every element must work without animation.
- **Specific CTAs.** "Advance 2 articles" not "Focus active wave". Use real data from the API.
- **Flow is a table, not a theater.** Wave chips + phase filter tabs + agent activity rows.
- **Knowledge and Graph are separate views.** No wiki/graph toggle confusion.
- **Security uses tabs.** Don't show 6 information blocks at once.
- **Sidebar scales.** System expands to show settings sub-nav, main nav stays at 6 items.

## What NOT to do

- Don't use a CSS framework (Tailwind, Bootstrap). Use the design tokens directly.
- Don't add a bundler or build step for the frontend.
- Don't create React components or JSX.
- Don't add new npm dependencies for the frontend (icons via CDN, graph lib via CDN if needed).
- Don't modify the existing API endpoints — only add static file serving.
- Don't add features not in the mockups.
