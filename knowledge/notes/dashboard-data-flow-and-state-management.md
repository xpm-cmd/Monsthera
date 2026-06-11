---
id: k-l7oy85r0
title: Dashboard data flow and state management
slug: dashboard-data-flow-and-state-management
category: context
tags: [dashboard, frontend, state-management, data-flow, patterns]
codeRefs: [public/pages/knowledge.js, public/pages/work.js, public/pages/search.js, public/pages/flow.js, public/pages/overview.js, public/lib/api.js]
references: []
createdAt: 2026-04-11T02:17:27.189Z
updatedAt: 2026-06-10T23:19:27.109Z
---

# Dashboard data flow and state management

The Monsthera dashboard is a vanilla JS single-page application with no framework, no virtual DOM, and no global store. Each page is a self-contained module that exports an `async render(container)` function. Understanding these patterns is essential before modifying any page.

## Page lifecycle

Every page module follows the same contract:

1. `render(container)` is called by the router, receiving the DOM container element.
2. The function fetches initial data via `Promise.all()` of API calls (all with `.catch(() => fallback)` to be resilient).
3. Local state variables are declared as mutable `let` bindings in the `render()` closure scope.
4. A `buildDOM()` function constructs a full DOM fragment from current state using a `<template>` element.
5. A `rerender()` function clears `container.textContent = ""`, appends the new DOM fragment, and re-initializes Lucide icons.
6. Event listeners are attached to `container` using event delegation.
7. The function returns `{ cleanup: () => ac.abort() }` for the router to call on navigation away.

Simpler pages deviate slightly: `events.js` keeps a `setInterval` auto-refresh (every 5s) and returns a plain cleanup function that clears the timer; `sessions.js` and the convoy pages are read-only and attach per-element listeners after each rebuild instead of delegated ones. `code.js` composes HTML via `Range.createContextualFragment` instead of `innerHTML`.

## State management: closure-scoped variables, no store

There is no global state, no Redux, no signals. Each page keeps state as local `let` variables inside the `render()` closure:

- **knowledge.js**: `articles`, `workArticles`, `selectedId`, `searchQuery`, `showCreate`, `flash`, `inputState`, `batchState` (bulk-import mode + payload), `batchResult`, `slugPreviewRequestId`
- **work.js**: `workArticles`, `directory`, `wave`, `convoys`, `convoyLeadMap`, `viewMode`, `expandedId`, `showCreate`, `flash`, `filters` (object with `query`, `phase`, `priority`, `state`), `snapshotDiffCache`
- **search.js**: `pack`, `selectedResult`, `selectedResultId`, `filterType`, `mode`, `query`, `debounceTimer`, `isLoading`, `errorMessage`, `loadRequestId`, `previewRequestId`, `inputState`
- **flow.js**: `directory`, `workArticles`, `wave`, `runtime`, `activePhase`, `flash`
- **overview.js**: `health`, `workArticles`, `knowledgeArticles`, `wave`, `runtime`, `directory`, `convoys`, `flash`
- **sessions.js**: `sessions`, `errorMessage`, `selected`, `selectedId`

State changes happen by mutating these variables directly, then calling `rerender()`.

## The mutation pattern: runMutation()

Pages with CRUD operations (knowledge.js, work.js) share a `runMutation(action, successMessage, preferredId)` pattern:

```js
async function runMutation(action, successMessage, preferredId) {
  try {
    const result = await action();
    flash = { kind: "success", message: successMessage };
    await refresh(result?.id || preferredId || null);
    rerender();
  } catch (error) {
    flash = { kind: "error", message: error?.message || "Request failed" };
    rerender();
  }
}
```

Key behaviors:
- `action` is an async function wrapping an API call (e.g., `() => createKnowledge({...})`).
- On success, it sets a flash notification, calls `refresh()` to re-fetch all data from the server, then re-renders.
- On failure, it sets an error flash and re-renders without refreshing data.
- `preferredId` controls which item stays selected/expanded after the mutation. The result's `id` takes priority if returned; the knowledge page also accepts `result?.items?.[0]?.articleId` (import/batch results).
- The knowledge page additionally resets `showCreate = false` on success.
- The work page clears its `snapshotDiffCache` after every successful mutation so the next render re-fetches snapshot-drift data.

## The refresh pattern

Each page has a `refresh()` function that re-fetches all data sources via `Promise.all()`:

```js
async function refresh(preferredId) {
  [articles, workArticles] = await Promise.all([
    getKnowledge().catch(() => []),
    getWork().catch(() => []),
  ]);
  // Re-validate selection
  if (preferredId && articles.some(a => a.id === preferredId)) {
    selectedId = preferredId;
  } else {
    selectedId = articles[0]?.id ?? null;
  }
}
```

This means every mutation triggers a full data reload from the server. There is no optimistic update -- the UI always reflects server truth after mutations.

## Re-rendering: teardown + rebuild

The `rerender()` function follows a destructive rebuild pattern:

```js
function rerender() {
  container.textContent = "";          // destroy entire DOM subtree
  container.appendChild(buildDOM());   // rebuild from scratch
  if (typeof lucide !== "undefined") lucide.createIcons({ nodes: [container] });
}
```

`buildDOM()` constructs HTML strings, injects them into a `<template>` element, and returns `template.content` (a DocumentFragment). The overview page is a slight variant: it uses a wrapper `<div>` and moves children into the container via `while (wrapper.firstChild) container.appendChild(wrapper.firstChild)`. The work page additionally runs `hydrateSnapshotDrift()` after each rebuild to fill snapshot-drift placeholders asynchronously.

**Important**: Because the entire DOM is rebuilt on every state change, any transient DOM state (focus, scroll position, text selection) is lost unless explicitly preserved. Collapsible hero callouts survive rebuilds because their collapsed/open state is read from `localStorage` (`monsthera-hero-<key>`) inside `renderHeroCallout`, not from the DOM.

## Input state preservation

Pages with search inputs (knowledge.js, search.js, work.js) implement cursor preservation to avoid losing the user's typing position during re-renders:

```js
let inputState = { restore: false, start: 0, end: 0 };

function captureInputState(input) {
  inputState = {
    restore: true,
    start: input.selectionStart ?? query.length,
    end: input.selectionEnd ?? query.length,
  };
}
```

After `rerender()`, if `inputState.restore` is true, the code finds the search input, calls `input.focus()` and `input.setSelectionRange(start, end)`. Non-search interactions (clicking articles, toggling create) set `inputState.restore = false` to avoid stealing focus. The work page inlines the same idea for its toolbar filter input (capture cursor, rerender, re-focus).

## Event delegation with data-* attributes

All event handling uses delegation: listeners are attached to the `container` element, not to individual buttons or forms. Handlers use `target.closest("[data-*]")` to identify which action was triggered:

```js
container.addEventListener("click", async (event) => {
  const advanceButton = target.closest("[data-advance-work]");
  if (advanceButton) {
    await runMutation(
      () => advanceWork(advanceButton.dataset.advanceWork, advanceButton.dataset.phase),
      `Moved article to ${advanceButton.dataset.phase}.`,
    );
    return;
  }
  // ... more handlers
});
```

Common data attribute patterns:
- `data-article="id"` — select a knowledge article
- `data-work-id="id"` — identify a work card (click to expand/collapse)
- `data-toggle-work="id"` — dedicated expand/collapse toggle button on work cards (with `aria-expanded`)
- `data-open-work="id"` — jump from board/list view to the queue view with that card expanded
- `data-advance-work="id" data-phase="next"` — advance lifecycle (on `GUARD_FAILED` the handler prompts for a justification and retries with `skipGuard`)
- `data-override-guard="id" data-phase="next"` — explicit guard override with prompted reason
- `data-cancel-work="id"` — cancel a work article with prompted reason
- `data-delete-knowledge="id"` / `data-delete-work="id"` — delete with confirmation
- `data-enrich-work="id" data-role="role" data-status="status"` — enrichment contribution
- `data-submit-review="id" data-reviewer="agentId" data-status="approved|changes-requested"` — review actions
- `data-remove-dependency="id" data-blocked-by="blockerId"` — unlink dependency
- `data-toggle-create` — show/hide create form
- `data-tab="queue|board|list"` — switch view mode
- `data-chip="phase"` — filter by phase
- `data-filter="all|knowledge|work"` — filter type in search
- `data-mode="code|research|general"` — search mode
- `data-result-id="id" data-result-type="knowledge|work"` — select search result
- `data-run-wave` — execute orchestration wave
- `data-filter-input` / `data-filter-select` — work page filter controls
- `data-session-id="id"` — select a session on the Sessions page
- `data-preview-slug-input` / `data-slug-preview` — live slug preview on knowledge create
- `data-batch-validate` — client-side validation of the knowledge bulk-import JSON payload
- `data-reindex-search` — trigger search reindex on Storage & Indexing
- `data-hero-toggle` (inside `[data-hero-key]`) — collapse/expand a hero callout (handled globally in app.js)

Form submissions are handled via a single `submit` listener that matches the form element using `form.matches("[data-knowledge-create]")`, `form.matches("[data-work-edit]")`, `form.matches("[data-knowledge-batch]")`, `form.matches("[data-knowledge-rename]")`, etc.

## AbortController cleanup pattern

Pages with delegated listeners create an `AbortController` and pass `{ signal: ac.signal }` as the third argument to every `addEventListener` call:

```js
const ac = new AbortController();
container.addEventListener("click", handler, { signal: ac.signal });
container.addEventListener("input", handler, { signal: ac.signal });
container.addEventListener("submit", handler, { signal: ac.signal });
return { cleanup: () => ac.abort() };
```

When the router navigates away, it calls `cleanup()`, which aborts the controller and automatically removes all listeners. The search page additionally clears its debounce timer in cleanup: `() => { ac.abort(); clearTimeout(debounceTimer); }`. The events page returns a plain function that clears its auto-refresh interval instead.

The search page also uses request-id guards to prevent stale async responses from overwriting newer state: `loadRequestId` for context-pack loads and `previewRequestId` for result previews — each request increments the counter and checks it (plus `ac.signal.aborted`) before applying results. The knowledge page applies the same guard (`slugPreviewRequestId`) to debounced slug-preview requests.

## API client (api.js)

The API layer is a thin wrapper around `fetch`:

- `request(path, options)` — core function that JSON-stringifies bodies, sets Content-Type, parses responses, and throws `ApiError` on non-OK status.
- **Auth**: `getAuthToken()` reads the `<meta name="monsthera-auth-token">` tag the server injects into index.html and attaches `Authorization: Bearer <token>` to every request — required because all `/api/*` endpoints (including GETs) are token-gated except health/status.
- Convenience wrappers: `get()`, `post()`, `patch()`, `del()`.
- Each API endpoint is a named export: `getKnowledge()`, `createWork()`, `advanceWork(id, phase, options)` (options carry `reason`/`skipGuard`), `search()`, `getSessions()`, `getConvoys()`, `getSystemEval()`, `getEvents()`, etc.
- All endpoint functions use `encodeURIComponent` for path parameters.
- Query parameters are built with `URLSearchParams`.
- `ApiError` includes `status` and `code` properties for structured error handling (e.g., work.js branches on `error.code === "GUARD_FAILED"`).
- 204 responses return `null`.

## Flash notifications

Flash messages are ephemeral: stored as `{ kind: "success"|"error", message: string }` and rendered as `<div class="inline-notice inline-notice--success|error">`. They persist across re-renders but are not automatically dismissed -- they stay until the next mutation replaces them or the page is re-navigated.

## HTML construction

All pages build HTML as string concatenation (template literals and array joins), then parse it via `<template>` elements. User-provided data is escaped with `esc()` from `components.js`. Markdown content is rendered with `renderMarkdown()` for preview panels. Shared UI components (`renderBadge`, `renderCard`, `renderTable`, `renderTabs`, `renderChips`, `renderStatCard`, `renderHeroCallout`, `renderAlert`, `renderSearchInput`, `renderPhaseChip`) are imported from `components.js`. `renderHeroCallout` accepts an optional `collapseKey` for the persisted collapse behavior.