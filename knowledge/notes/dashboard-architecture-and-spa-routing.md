---
id: k-2jb9bh3p
title: Dashboard architecture and SPA routing
slug: dashboard-architecture-and-spa-routing
category: context
tags: [dashboard, frontend, spa, routing, architecture]
codeRefs: [public/app.js, public/lib/router.js, public/lib/sidebar.js, public/index.html, src/dashboard/index.ts, src/dashboard/auth.ts]
references: []
createdAt: 2026-04-11T02:17:46.615Z
updatedAt: 2026-04-11T02:17:46.615Z
---

# Dashboard Architecture and SPA Routing

## Overview

The Monsthera dashboard is a **vanilla JavaScript single-page application** — no framework (React, Vue, etc.). It uses the browser's History API for client-side routing, ES module dynamic imports for lazy page loading, and a simple page lifecycle with load/cleanup semantics. The backend serves both static files and the REST API on a single HTTP port.

## Shell HTML (`public/index.html`)

The HTML shell is minimal:
```html
<div id="app">
  <aside id="sidebar"></aside>
  <main id="content">Loading...</main>
</div>
```
- Loads **Lucide icons** from CDN (`unpkg.com/lucide@latest`)
- Loads three Google Fonts: **Manrope** (body), **Space Grotesk** (headings), **Geist Mono** (code)
- Entry module: `<script type="module" src="/app.js">`
- Default theme is `data-theme="dark"` on `<html>`

## Client-Side Router (`public/lib/router.js`)

A custom `Router` class (~70 lines) wrapping the History API:

- **Pattern matching**: Routes are registered with `router.add(pattern, handler)`. Patterns support named params (e.g., `/knowledge/:id`) converted to regex with named capture groups.
- **Navigation**: `router.navigate(path)` calls `history.pushState()` then resolves the route. Same-path navigations are no-ops.
- **Popstate**: `router.start()` listens for `popstate` events (browser back/forward) and re-resolves.
- **404 handling**: `router.onNotFound(handler)` registers a fallback.
- **Exported helper**: `navigate(path)` is a convenience wrapper for `router.navigate()`.

Route resolution normalizes trailing slashes and decodes URI components for param values.

## Page Lifecycle (`public/app.js`)

The SPA entry point manages page transitions via a `loadPage(modulePath, params)` function:

1. **Navigation ID tracking**: Each navigation increments a `navigationId` counter. If a newer navigation starts while a page is still loading, the stale load is silently aborted (race condition guard).
2. **Teardown**: `teardownCurrentPage()` calls the previous page's cleanup function (if any) and clears the `#content` element via `textContent = ""`.
3. **Loading state**: A "Loading..." div is shown while the module is fetched.
4. **Dynamic import**: `await import(modulePath)` lazily loads the page module.
5. **Render**: `mod.render(container, params)` is called. The render function receives the `#content` DOM element and route params.
6. **Cleanup contract**: If `render()` returns a function, it becomes the cleanup callback. If it returns an object with a `cleanup` property, that is used instead. Called on next navigation.
7. **Lucide icons**: After render, `lucide.createIcons()` is called scoped to the content element to hydrate icon placeholders.

## Route-to-Module Mapping

```
/                    → pages/overview.js
/guide               → pages/guide.js
/flow                → pages/flow.js
/work                → pages/work.js
/knowledge           → pages/knowledge.js
/knowledge/graph     → pages/knowledge-graph.js
/search              → pages/search.js
/system              → pages/system/health.js
/system/models       → pages/system/models.js
/system/agents       → pages/system/agents.js
/system/integrations → pages/system/integrations.js
/system/storage      → pages/system/storage.js
/security            → pages/security.js
```

## Link Interception

A global `click` event listener on `document` intercepts clicks on elements with `[data-link]` attribute. Instead of a full page load, it calls `router.navigate(href)` for SPA navigation. All internal links must use `data-link` to opt in.

## Sidebar (`public/lib/sidebar.js`)

The sidebar renders a fixed navigation menu with:
- **NAV_ITEMS**: 7 top-level items (Overview, Guide, Flow, Work, Knowledge, Search, System), each with a Lucide icon name and path.
- **SYSTEM_SUBNAV**: 6 sub-items under System (Health, Models & Runtime, Agent Profiles, Integrations, Storage & Indexing, Security).
- **Active state**: Computed by prefix-matching `currentPath` against item paths. System is active when path starts with `/system` or is `/security`.
- **Theme toggle**: A sun/moon button in the sidebar footer toggles `data-theme` between "dark" and "light", persisted to `localStorage` under key `monsthera-theme`.
- **Re-render**: `updateSidebar(currentPath)` re-renders the entire sidebar HTML and re-hydrates Lucide icons. Called on every navigation.

The sidebar uses `innerHTML` but only with hardcoded nav item data — no user or API input is interpolated (noted in security comment).

## Backend: Static Files + REST API (`src/dashboard/index.ts`)

The dashboard server is a raw Node.js `http.createServer()` — no Express or framework.

### Static File Serving
- Resolves `public/` directory (configurable via `options.publicDir`, defaults to `<cwd>/public`).
- Serves files with correct MIME types (HTML, CSS, JS, JSON, images, fonts, SVG).
- **Directory traversal protection**: `path.resolve()` + prefix check ensures the resolved path stays within `publicDir`.
- **SPA fallback**: Extensionless paths (SPA routes like `/knowledge`) serve `index.html`. Paths with file extensions that don't exist return 404 directly.

### Server Lifecycle
- `startDashboard(container, port?, options?)` creates the HTTP server.
- Listens on configured host/port (defaults from `container.config.server`).
- Returns a `DashboardServer` object with `port`, `authToken`, and `close()`.

### CORS
Full CORS support: `Access-Control-Allow-Origin: *`, allowing cross-origin API access. Preflight `OPTIONS` requests return 204 with allowed methods and headers.

## Auth Model (`src/dashboard/auth.ts`)

Token-based authentication using Bearer tokens:

- **Exempt paths**: `GET /api/health` and `GET /api/status` skip auth (safe for monitoring).
- **Exempt methods**: All `GET` and `OPTIONS` requests skip auth entirely — only mutating requests (POST, PATCH, DELETE) require a token.
- **Token validation**: Uses `crypto.timingSafeEqual()` to prevent timing attacks when comparing the provided Bearer token against the server token.
- **Token generation**: `generateToken()` produces 32 random bytes as hex (64-char string).
- **Configuration**: Token is taken from `container.config.dashboard.authToken` (env var `MONSTHERA_DASHBOARD_TOKEN`), or auto-generated at startup if not set.

## Key Design Decisions

1. **No build step**: All frontend code is plain ES modules served directly. No bundler, no transpilation.
2. **Lazy loading**: Page modules are loaded on demand via dynamic `import()`, keeping initial load fast.
3. **Security-first innerHTML**: The codebase uses `innerHTML` but with strict discipline — all API data passes through `esc()`, and security notes are documented at the top of files that use `innerHTML`.
4. **Single-port architecture**: Static files and API share one HTTP port, simplifying deployment.
5. **Framework-free**: Deliberate choice to avoid framework overhead. Pages are render functions that return cleanup callbacks.
