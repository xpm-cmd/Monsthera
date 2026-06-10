---
id: k-2jb9bh3p
title: Dashboard architecture and SPA routing
slug: dashboard-architecture-and-spa-routing
category: context
tags: [dashboard, frontend, spa, routing, architecture]
codeRefs: [public/app.js, public/lib/router.js, public/lib/sidebar.js, public/index.html, src/dashboard/index.ts, src/dashboard/auth.ts]
references: []
createdAt: 2026-04-11T02:17:46.615Z
updatedAt: 2026-06-10T23:18:36.410Z
---

# Dashboard Architecture and SPA Routing

## Overview

The Monsthera dashboard is a **vanilla JavaScript single-page application** — no framework (React, Vue, etc.). It uses the browser's History API for client-side routing, ES module dynamic imports for lazy page loading, and a simple page lifecycle with load/cleanup semantics. The backend serves both static files and the REST API on a single HTTP port. All third-party assets (icons, fonts, graph library) are **self-hosted under `public/vendor/`** — the dashboard makes no external CDN requests.

## Shell HTML (`public/index.html`)

The HTML shell is minimal:
```html
<div id="app">
  <aside id="sidebar"></aside>
  <main id="content"><div class="loading">Loading...</div></main>
</div>
```
- Loads **Lucide icons** from the self-hosted bundle `/vendor/lucide.min.js` (no unpkg)
- Loads three self-hosted fonts via `/vendor/fonts.css` (woff2 files under `/vendor/fonts/`): **Manrope** (body), **Space Grotesk** (headings), **Geist Mono** (code) — no Google Fonts requests
- Entry module: `<script type="module" src="/app.js">`
- Default theme is `data-theme="dark"` on `<html>`
- At serve time the server injects `<meta name="monsthera-auth-token" content="...">` into `<head>` (see Auth Model below)

## Client-Side Router (`public/lib/router.js`)

A custom `Router` class (~70 lines) wrapping the History API:

- **Pattern matching**: Routes are registered with `router.add(pattern, handler)`. Patterns support named params (e.g., `/convoys/:id`) converted to regex with named capture groups.
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

`app.js` also installs a global click handler for **collapsible hero callouts**: clicks on `[data-hero-toggle]` toggle the `hero-callout--collapsed` class on the enclosing `[data-hero-key]` section and persist the choice in `localStorage` under `monsthera-hero-<key>` (same pattern as `monsthera-theme`). Pages opt in by passing `collapseKey` to `renderHeroCallout` (flow, knowledge, work, search, sessions use it).

## Route-to-Module Mapping

```
/                    → pages/overview.js
/guide               → pages/guide.js
/flow                → pages/flow.js
/work                → pages/work.js
/convoys             → pages/convoys.js
/convoys/:id         → pages/convoy.js
/code                → pages/code.js
/events              → pages/events.js
/knowledge           → pages/knowledge.js
/knowledge/graph     → pages/knowledge-graph.js
/search              → pages/search.js
/sessions            → pages/sessions.js
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
- **NAV_ITEMS**: 11 top-level items (Overview, Guide, Flow, Work, Events, Convoys, Code, Knowledge, Search, Sessions, System), each with a Lucide icon name and path.
- **SYSTEM_SUBNAV**: 6 sub-items under System (Health, Models & Runtime, Agent Profiles, Integrations, Storage & Indexing, Security). The subnav is collapsed by default and gets the `.open` class while a System route (or `/security`) is active.
- **Active state**: Computed by prefix-matching `currentPath` against item paths. System is active when path starts with `/system` or is `/security`.
- **Convoy warning badge**: The Convoys nav item carries `<span class="nav-badge" id="convoy-warning-badge" hidden>`. `refreshConvoyWarningBadge()` (single-flight, called from `updateSidebar`) fetches `GET /api/convoys` and, when unresolved warnings exist, fills the count and sets `role="status"`, an `aria-label`, and a `title` tooltip ("N unresolved convoy warning(s)"); with zero warnings the badge is hidden again (`.nav-badge[hidden] { display: none; }` in styles.css). Fetch errors are silent — the previous count is preserved.
- **Theme toggle**: A sun/moon button in the sidebar footer toggles `data-theme` between "dark" and "light", persisted to `localStorage` under key `monsthera-theme`.
- **Re-render**: `updateSidebar(currentPath)` re-renders the entire sidebar HTML, re-hydrates Lucide icons, and refreshes the convoy badge. Called on every navigation.
- **Responsive**: below 900px viewport width the sidebar stacks above the content (`#app` becomes a column, nav items wrap as a row); the `<li>` that owns the System subnav spans a full row, and the subnav keeps its collapsed/`.open` behavior rather than being forced open.

The sidebar uses `innerHTML` but only with hardcoded nav item data — no user or API input is interpolated (noted in security comment).

## Backend: Static Files + REST API (`src/dashboard/`)

The dashboard server is a raw Node.js `http.createServer()` — no Express or framework. Since the Wave D0 router split it is organized as:

- **`src/dashboard/index.ts`** (~190 lines): the composition root — server lifecycle (`startDashboard`), CORS/OPTIONS preflight handling, the auth gate, a 405 method pre-guard for read-only paths, the ordered route chain, static-file dispatch, and the 404 fallback.
- **`src/dashboard/routes/*.ts`**: the 33 route handlers live in domain modules (`system`, `orchestration`, `code-intel`, `ingest`, `agents`, `knowledge`, `work`, `search`, `sessions`, `convoys`), each exporting `handle<Domain>Routes(ctx): Promise<boolean>` — `true` means "matched and responded", `false` lets the chain continue. `routes/context.ts` defines the shared `RouteContext` (`req`, `res`, `url`, `pathname`, `container`).
- **`src/dashboard/http.ts`**: shared HTTP plumbing — `serveStatic`, `injectAuthToken`, the CORS policy (`isAllowedDashboardOrigin`, `applyCorsHeaders`, `corsHeaders`), `jsonResponse`/`errorResponse`, `parseJsonBody`, and `mapErrorToHttp`.
- **`src/dashboard/auth.ts`**: token validation and generation.

### Static File Serving (`http.ts → serveStatic`)
- Resolves `public/` directory (configurable via `options.publicDir`, defaults to `<cwd>/public`).
- Serves files with correct MIME types (HTML, CSS, JS, JSON, images, fonts, SVG).
- **Directory traversal protection**: `path.resolve()` + prefix check ensures the resolved path stays within `publicDir`.
- **Auth token injection**: every served HTML document gets the dashboard token injected as a `<meta name="monsthera-auth-token">` tag (acceptable because the token is only meaningful within the localhost trust boundary).
- **SPA fallback**: Extensionless paths (SPA routes like `/knowledge`) serve `index.html`. Paths with file extensions that don't exist return 404 directly.

### Server Lifecycle
- `startDashboard(container, port?, options?)` creates the HTTP server.
- Listens on configured host/port (defaults from `container.config.server`; `localhost` is normalized to `127.0.0.1`).
- Returns a `DashboardServer` object with `port`, `authToken`, and `close()`.

### CORS
**Locked-down allowlist — not wildcard.** `isAllowedDashboardOrigin()` (in `http.ts`, re-exported from `index.ts`) accepts only same-origin/no-Origin callers and `http(s)` origins whose hostname is `localhost`, `127.0.0.1`, or IPv6 loopback. Browser requests from any other origin are rejected early with `403 FORBIDDEN_ORIGIN`. Allowed origins are echoed back via `Access-Control-Allow-Origin: <origin>` plus `Vary: Origin`. Preflight `OPTIONS` requests return 204 with allowed methods (`GET, POST, PATCH, DELETE, OPTIONS`), allowed headers (`Content-Type, Authorization`), and a 24h max-age. Origin-less callers (curl, Node fetch, MCP clients) are unaffected.

## Auth Model (`src/dashboard/auth.ts` + the gate in `index.ts`)

Token-based authentication using Bearer tokens. **Since PR #143, every `/api/*` request — including GET — requires a valid token**; the old GET exemption is gone because read endpoints expose the corpus.

- **Exempt paths**: `/api/health` and `/api/status` skip auth (safe for monitoring).
- **Exempt methods**: only `OPTIONS` (CORS preflight carries no Authorization header by design). GET is deliberately NOT exempt.
- **Token validation**: Uses `crypto.timingSafeEqual()` (with a length pre-check) to prevent timing attacks when comparing the provided Bearer token against the server token.
- **Token generation**: `generateToken()` produces 32 random bytes as hex (64-char string).
- **Configuration**: Token is taken from `container.config.dashboard.authToken` (env var `MONSTHERA_DASHBOARD_TOKEN`), or auto-generated at startup if not set.
- **SPA integration**: the token is injected into served HTML as a meta tag; `public/lib/api.js` reads it and attaches `Authorization: Bearer <token>` to every request (GETs included).
- Failures return `401 { error: "UNAUTHORIZED", message: "Valid Bearer token required" }`.

## Key Design Decisions

1. **No build step**: All frontend code is plain ES modules served directly. No bundler, no transpilation.
2. **Lazy loading**: Page modules are loaded on demand via dynamic `import()`, keeping initial load fast.
3. **Security-first innerHTML**: The codebase uses `innerHTML` but with strict discipline — all API data passes through `esc()`, and security notes are documented at the top of files that use `innerHTML`.
4. **Single-port architecture**: Static files and API share one HTTP port, simplifying deployment.
5. **Framework-free**: Deliberate choice to avoid framework overhead. Pages are render functions that return cleanup callbacks.
6. **Local-first assets**: Lucide, Cytoscape, and all fonts are vendored under `public/vendor/` so the dashboard works fully offline and leaks nothing to CDNs.
7. **Domain-split router**: route bodies live in `routes/*.ts` modules behind a boolean-returning chain, keeping `index.ts` a small composition root.