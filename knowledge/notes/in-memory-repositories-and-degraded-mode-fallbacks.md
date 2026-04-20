---
id: k-q2wz8nb0
title: In-memory repositories and degraded-mode fallbacks
slug: in-memory-repositories-and-degraded-mode-fallbacks
category: context
tags: [in-memory, fallbacks, testing, repositories, degraded-mode]
codeRefs: [src/knowledge/in-memory-repository.ts, src/work/in-memory-repository.ts, src/search/in-memory-repository.ts, src/orchestration/in-memory-repository.ts, src/core/repository.ts, src/core/container.ts]
references: [adr-001-storage-model, knowledgeservice-crud-search-sync-and-wiki-integration, monsthera-work-article-design, in-memory-search-index-bm25-scoring-and-fallback-behavior]
createdAt: 2026-04-18T07:40:31.038Z
updatedAt: 2026-04-18T07:40:31.038Z
---

## Overview

Monsthera's in-memory repositories serve two roles at once:

- deterministic test doubles for unit/integration tests
- operational fallbacks when the derived-data backend is unavailable

They are not a separate architecture. They implement the same repository contracts described by [[adr-001-storage-model]] so that services can keep running even when Dolt-backed derived storage is not present.

## Knowledge in-memory repository

`src/knowledge/in-memory-repository.ts` is a compact implementation of the knowledge repository contract:

- articles live in a `Map`
- slug uniqueness is preserved with `uniqueSlug()`
- create/update/delete/query methods follow the same `Result<T, E>` conventions as the filesystem repo

Its main value is testability: service behavior can be exercised without touching the filesystem.

## Work in-memory repository

`src/work/in-memory-repository.ts` is richer because work articles carry lifecycle state:

- terminal-phase mutation guards
- enrichment and reviewer state
- dependency cleanup on delete
- phase advancement with history tracking
- default content generation from templates

So while it is "in-memory", it is still a domain-aware implementation of the work model, not just a bag of objects.

## Search and orchestration fallbacks

The derived-data subsystems also have in-memory implementations:

- [[in-memory-search-index-bm25-scoring-and-fallback-behavior]] for search
- `src/orchestration/in-memory-repository.ts` for orchestration events

These are the pieces the container swaps in when Dolt-backed persistence is unavailable.

## Container degraded mode

`createContainer()` keeps Markdown repositories as the source of truth, but if Dolt initialization fails it falls back to in-memory search and orchestration repositories. The storage subsystem is then marked degraded rather than pretending nothing changed.

That distinction matters: degraded mode keeps Monsthera usable, but it is still a fallback mode around derived data, not a new source of truth.

## Why this matters for documentation

Whenever a knowledge article describes repository behavior, it should be clear whether it is talking about:

- the source-of-truth repository for persisted articles
- an in-memory implementation used for testing or fallback
- the service layer that sits above both

Mixing those layers makes operational debugging much harder.