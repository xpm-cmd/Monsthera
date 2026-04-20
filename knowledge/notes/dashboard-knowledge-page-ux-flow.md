---
id: k-w8xru25o
title: Dashboard knowledge page UX flow
slug: dashboard-knowledge-page-ux-flow
category: context
tags: [dashboard, knowledge, ux, crud, import]
codeRefs: [public/pages/knowledge.js]
references: []
createdAt: 2026-04-11T02:18:12.669Z
updatedAt: 2026-04-11T02:18:12.669Z
---

# Dashboard knowledge page UX flow

The knowledge page (`public/pages/knowledge.js`) provides the full CRUD interface for Monsthera's knowledge articles. It uses a three-column layout: navigation sidebar, content center, and metadata panel.

## Layout structure

```
┌─────────────────────────────────────────────────────────────┐
│ Page header: "Knowledge" + [Open guide] [New article] [Graph] │
├─────────────────────────────────────────────────────────────┤
│ Flash notification (success/error, if any)                  │
├─────────────────────────────────────────────────────────────┤
│ Hero callout: "Save what should survive the current task"   │
│   Steps: Capture → Ground → Reuse                           │
├────────────┬──────────────────────────┬─────────────────────┤
│ col-nav    │ col-content              │ col-meta            │
│            │                          │                     │
│ Search bar │ [Create form]            │ Backlinks & related │
│            │ [Import form]            │ Code references     │
│ Category   │                          │ Context quality     │
│ grouped    │ Selected article header  │ Actions (delete)    │
│ article    │ Edit form                │                     │
│ list       │ Markdown preview         │                     │
│            │                          │                     │
└────────────┴──────────────────────────┴─────────────────────┘
```

## Initial data loading

On render, the page fetches both knowledge articles and work articles in parallel:

```js
let [articles, workArticles] = await Promise.all([
  getKnowledge().catch(() => []),
  getWork().catch(() => []),
]);
```

Work articles are needed for computing backlinks (cross-references between work and knowledge).

## Navigation sidebar (col-nav)

### Search filter
A text input filters articles client-side by matching the query against `title`, `category`, and `tags` (all case-insensitive, substring match via `.includes()`). Filtering happens on every keystroke via an `input` event listener on the `.search-input` element. The cursor position is preserved across re-renders using the `captureInputState`/`inputState` mechanism.

### Category-grouped article list
Filtered articles are grouped by category using a `Map`. Each category becomes a `nav-list-group` header, and articles within it are rendered as clickable links with `data-article="id"` attributes. The currently selected article gets the `active` CSS class.

### Freshness badges
Each article in the nav list displays a freshness badge from `article.diagnostics.freshness`:
- `fresh` → green success badge
- `attention` → yellow warning badge
- `stale` → red error badge
- Other/missing → outline badge

## Create form

Toggled by the "New article" / "Close form" button (`data-toggle-create`). When visible, it appears at the top of the center column. Fields:

| Field | Type | Default | Required |
|-------|------|---------|----------|
| Title | text input | — | yes |
| Category | text input | "engineering" | yes |
| Tags | text input (CSV) | — | no |
| Code refs | text input (CSV) | — | no |
| Content | textarea | — | yes |

On submit (`data-knowledge-create` form), the handler:
1. Extracts `FormData` values
2. Parses tags and codeRefs as CSV (split by comma, trim, filter empty)
3. Calls `createKnowledge({title, category, tags, codeRefs, content})`
4. Uses `runMutation()` which sets success flash, refreshes data, re-renders
5. Resets the form and restores `category` to "engineering"

## Import form

Shown alongside the create form when `showCreate` is true. Allows importing local filesystem sources into knowledge articles. Fields:

| Field | Type | Default | Required |
|-------|------|---------|----------|
| Source path | text input | — | yes |
| Category override | text input | — | no |
| Tags | text input (CSV) | — | no |
| Code refs (extra) | text input (CSV) | — | no |
| Summary mode | checkbox | unchecked | no |
| Recursive | checkbox | checked | no |
| Replace existing | checkbox | checked | no |

On submit (`data-knowledge-import` form), calls `ingestLocalKnowledge()` with:
- `mode`: "summary" if summaryMode checked, otherwise "raw"
- `recursive`: boolean from checkbox
- `replaceExisting`: boolean from checkbox
- Optional category, tags, codeRefs

The import result may return `items[0].articleId` which is used as the preferred selection after refresh.

## Inline editor (center column)

When an article is selected, the center column shows:

1. **Article header**: Title (h2), category badge, freshness badge, quality score badge, "Updated X ago" timestamp.

2. **Edit form** (`data-knowledge-edit="id"`): Pre-populated with the selected article's data. Same fields as create (title, category, tags as CSV, codeRefs as CSV, content textarea). On submit, calls `updateKnowledge(id, {title, category, tags, codeRefs, content})` via `runMutation()`, preserving the article's ID as the preferred selection.

3. **Markdown preview**: Rendered below the edit form using `renderMarkdown(article.content)` inside a `markdown-preview` div. This gives live preview of what the content looks like rendered.

## Metadata panel (col-meta)

### Backlinks & related
Computes two counts:
- **Work backlinks**: Work articles that reference this knowledge article by ID or slug in their `references` array, OR share any `codeRef` with this article.
- **Related knowledge**: Other knowledge articles that share at least one tag with the selected article.

Displayed as simple text: "X linked work article(s), Y related knowledge article(s)".

### Code references
Lists all `codeRefs` from the selected article as monospace text items. Shows "No code references" if empty.

### Context quality diagnostics
When `article.diagnostics` exists, displays:
- Quality label and numeric score (e.g., "Good · 72/100")
- Quality summary text
- `recommendedFor` badges showing which modes (code, research, general) the article is recommended for

### Actions card
Shows:
- Article ID (monospace)
- Source path (if the article was imported from a local file)
- Freshness detail text (if available)
- **Delete button** (`data-delete-knowledge="id"`): Triggers `window.confirm()` dialog before deleting. On confirm, calls `deleteKnowledge(id)` via `runMutation()` with `preferredId = null` (selection falls to first article).

## Key interaction flows

### Selecting an article
Click on an article link in the nav → sets `selectedId`, triggers `rerender()`. The editor and metadata panels update to show the selected article.

### Creating an article
1. Click "New article" → `showCreate = true`, shows create + import forms
2. Fill form, submit → `runMutation()` creates article, hides forms, selects new article
3. Error → flash notification, forms stay visible

### Editing an article
1. Select article in nav → editor loads with current values
2. Modify fields, click "Save article" → `runMutation()` updates, refreshes, re-selects same article
3. Markdown preview updates on each re-render (not live as you type, only after save and re-render)

### Importing sources
1. Click "New article" to show forms
2. Fill import form with source path
3. Submit → `runMutation()` calls `ingestLocalKnowledge()`, hides forms, selects first imported article

### Deleting an article
1. Click "Delete article" in actions card
2. Browser confirm dialog appears
3. On confirm → `runMutation()` deletes, selection falls to first remaining article
