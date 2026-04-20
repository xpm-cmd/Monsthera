---
id: k-imz9hai0
title: Dashboard UI component library
slug: dashboard-ui-component-library
category: context
tags: [dashboard, frontend, components, design-system, security, xss]
codeRefs: [public/lib/components.js, public/styles.css, public/index.html]
references: []
createdAt: 2026-04-11T02:18:32.920Z
updatedAt: 2026-04-11T02:18:32.920Z
---

# Dashboard UI Component Library

## Overview

All reusable UI primitives live in `public/lib/components.js`. Every component is a pure function that returns an HTML string. Components are composed by concatenating strings — no virtual DOM, no templates. All user/API data is escaped via `esc()` before interpolation.

## Exported Components

### `renderCard(title, contentHtml, actionsHtml)`
Renders a `.card` container with optional title (auto-escaped) and actions footer. The `contentHtml` parameter is raw HTML (caller is responsible for escaping any dynamic data within it). Actions appear in a `mt-8` div.

### `renderBadge(text, variant)`
Inline badge/pill with variant styling. Variants: `"primary"`, `"secondary"`, `"success"`, `"warning"`, `"error"`, `"outline"`. Text is auto-escaped. Renders as `<span class="badge badge--{variant}">`.

### `renderStatCard(label, value, badge)`
Numeric stat display with label, large value, and optional badge below. Both label and value are escaped. Used on overview and system pages for KPIs.

### `renderAlert(title, body, actions)`
Alert box with a zap icon, escaped title and body, and optional actions area. Used for important notifications and orchestration prompts.

### `renderHeroCallout({ eyebrow, title, body, meta, steps })`
Large hero section used at the top of pages. Supports:
- `eyebrow`: Small label above the title
- `title`: Main heading
- `body`: Description paragraph
- `meta`: Array of pre-rendered HTML strings (badges, etc.) shown in a meta row
- `steps`: Array of `{ title, detail }` objects rendered as step cards

All text fields are escaped. Meta items are raw HTML (caller escapes).

### `renderTable(columns, rows)`
Full HTML table wrapped in `.table-card`. Columns define `{ label, key, align?, width?, render? }`. If a column has a `render` function, it receives the row and returns raw HTML (caller must escape). Otherwise the value is auto-escaped via `esc(String(row[key]))`. Supports right-alignment and fixed widths.

### `renderTabs(items, activeId)`
Horizontal tab bar. Items are `{ id, label }`. The active tab gets class `"active"`. Emits `data-tab="{id}"` attribute for event delegation.

### `renderChips(items, activeId)`
Filter chip bar (similar to tabs but pill-shaped). Items are `{ id, label, count? }`. Active chip gets `"active"` class. Emits `data-chip="{id}"`. Count is shown as a small inline number.

### `renderSearchInput(placeholder, value)`
Search input with a Lucide search icon. Both placeholder and value are escaped. Wrapped in `.search-input-wrap`. Pages listen for `input` events on `.search-input` for filtering.

### `renderMarkdown(text)`
Lightweight markdown-to-HTML converter. Supports:
- Headings: `#`, `##`, `###` → `<h2>`, `<h3>`, `<h4>`
- Bold: `**text**` → `<strong>`
- Italic: `*text*` → `<em>`
- Inline code: `` `code` `` → `<code>`
- Links: `[label](url)` → `<a href="url">`
- Paragraphs: double newlines → `</p><p>`

**Security**: Input is first HTML-escaped (`&`, `<`, `>`), then markdown syntax is applied. Links are sanitized: URLs are stripped of control characters and tested against `javascript:`, `data:`, and `vbscript:` schemes (case-insensitive). Unsafe links render as plain text.

## Helpers

### `esc(str)`
**The XSS prevention function.** Escapes `&`, `<`, `>`, and `"` in any string. Returns empty string for null/undefined. Every component that interpolates API data calls this. The entire dashboard's XSS defense relies on consistent use of `esc()`.

### `timeAgo(iso)`
Converts ISO timestamp to human-readable relative time: "just now", "5m ago", "3h ago", "2d ago". Returns empty string for falsy input.

### `priorityVariant(priority)`
Maps work priority strings to badge variants: critical→error, high→warning, medium→secondary, low→outline.

### `phaseVariant(phase)`
Maps work phase strings to badge variants: planning→outline, enrichment→secondary, implementation→primary, review→warning, done→success, cancelled→error.

## Design System (`public/styles.css`)

### CSS Custom Properties (Design Tokens)

The theme is controlled entirely through CSS variables on `:root` (light) and `[data-theme="dark"]` (dark). Key tokens:

**Colors:**
- `--background`: Page background (#F3F7F1 light / #0E1713 dark)
- `--card`: Card surface with transparency (rgba white-ish light / rgba dark-green dark)
- `--tile`: Tile/section background
- `--foreground`: Primary text (#16221D light / #EDF5EF dark)
- `--muted-foreground`: Secondary text
- `--primary`: Brand green (#1E7A4E light / #8DDEAA dark)
- `--primary-foreground`: Text on primary
- `--border`: Border color
- `--secondary`, `--secondary-foreground`: Secondary surfaces and text
- Semantic colors: `--color-success`, `--color-warning`, `--color-error` (each with `-fg` variant)

**Sidebar tokens:** `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-border` — separate from main content for visual distinction.

**Spacing & Radii:**
- `--radius-xs`: 6px, `--radius-m`: 16px, `--radius-l`: 24px, `--radius-pill`: 999px
- `--shadow-soft`: Subtle elevation, `--shadow-hover`: Hover lift effect

### Typography
- Body: **Manrope** (sans-serif), 16px base, 1.5 line-height
- Headings: **Space Grotesk** (loaded but applied via CSS classes)
- Code: **Geist Mono** (monospace)
- Anti-aliased rendering (`-webkit-font-smoothing: antialiased`)

### Theme
- Default is dark (`data-theme="dark"` on `<html>`)
- Toggle via sidebar button, persisted to `localStorage` key `monsthera-theme`
- All color transitions are instant (no CSS transitions on theme change)
- Background uses layered radial gradients for subtle depth

### Layout
- `#app` is a sidebar + main content layout
- Sidebar is a fixed-width aside
- `#content` (main) fills the remaining space
- Pages use utility classes: `.mt-8`, `.mt-16`, `.flex`, `.gap-8`, `.text-sm`, `.text-xs`, `.text-muted`, `.mono`

## XSS Prevention Strategy

The dashboard's security model for XSS is documented via comments at the top of `app.js` and `sidebar.js`:

1. **`esc()` is the single escape point.** All API-derived data passes through it before HTML interpolation.
2. **Static strings are safe.** Files that use `innerHTML` with only hardcoded strings note this in a security comment.
3. **`renderMarkdown()` double-protects.** It HTML-escapes first, then applies markdown syntax. Links are sanitized against `javascript:` and `data:` URI schemes, including obfuscated variants with control characters.
4. **Component contract.** Parameters named `contentHtml` or `actionsHtml` are raw HTML — the caller is responsible for escaping dynamic data within them. Parameters named `title`, `text`, `label`, `value` are auto-escaped by the component.
