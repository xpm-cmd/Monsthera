---
id: k-gi8pj4gg
title: Core runtime state, logging, and startup bootstrap
slug: core-runtime-state-logging-and-startup-bootstrap
category: context
tags: [core, runtime-state, bootstrap, status, logging]
codeRefs: [src/core/runtime-state.ts, src/core/container.ts, src/core/status.ts, src/core/logger.ts, src/core/constants.ts, src/search/service.ts]
references: [monsthera-hybrid-knowledge-architecture-v6, searchservice-unified-search-indexing-and-context-packs, adr-005-surface-boundaries]
createdAt: 2026-04-18T07:40:30.763Z
updatedAt: 2026-04-18T07:40:30.763Z
---

## Overview

The runtime-state layer is Monsthera's "last-known facts" cache for process restarts. It persists a small JSON snapshot under .monsthera/runtime-state.json, while the boot path in `createContainer()` decides which of those facts can be trusted and which must be recomputed from live services.

This topic sits between [[monsthera-hybrid-knowledge-architecture-v6]], [[searchservice-unified-search-indexing-and-context-packs]], and [[adr-005-surface-boundaries]]. It is where Monsthera turns persistent Markdown truth into a usable live runtime without pretending the derived index is authoritative.

## What runtime-state stores

`RuntimeStateSnapshot` currently persists:

- `knowledgeArticleCount`
- `workArticleCount`
- `searchIndexSize`
- `lastReindexAt`
- `lastMigrationAt`

The implementation is intentionally tiny. `read()` returns an empty object on `ENOENT` or malformed JSON, so a bad cache file does not block startup. `write()` shallow-merges new fields into the current snapshot and rewrites the whole file.

## How boot uses live checks

At startup, `createContainer()` wires the repositories and services first, then compares persisted runtime facts against the live process:

1. It counts knowledge and work articles from the repositories.
2. It records those counts into `StatusReporter` immediately.
3. It reads runtime-state for historical fields such as `lastMigrationAt`.
4. It runs `searchService.runCanary()` against the live search repository.
5. If source articles exist but the live search repo is empty or unhealthy, it bootstraps the search index with `fullReindex()`.

That split is important: runtime-state is helpful context, but not the source of truth. Markdown files stay authoritative, and live service checks win when the persisted snapshot disagrees with the in-memory runtime.

## Logging and status reporting

Two core primitives make this visible:

- `createLogger()` emits structured JSON log entries to stderr.
- `createStatusReporter()` aggregates subsystem health checks plus arbitrary stats.

The logger's `.child()` API carries contextual fields like `domain` and `operation`, which is why container boot, search reindex, and orchestration events can all speak a shared log dialect without a framework.

## Why the split exists

Monsthera has three different levels of "state":

- Markdown articles and work files: truth
- Search index and orchestration repositories: derived operational data
- runtime-state.json: convenience metadata for process restart UX

Keeping those layers separate prevents the system from mistaking a stale cache for a healthy runtime. It also means documentation about startup should always link both the persisted view and the live-search view.

## Authoring guidance

When you write operational docs about boot or diagnostics, include both of these dimensions:

- the persistent artifact under `.monsthera/`
- the live recomputation path in [[searchservice-unified-search-indexing-and-context-packs]]

That is what makes knowledge articles traceable from architecture decisions down to concrete boot code.