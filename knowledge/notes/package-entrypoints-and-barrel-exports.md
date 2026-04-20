---
id: k-hvaoejze
title: Package entrypoints and barrel exports
slug: package-entrypoints-and-barrel-exports
category: reference
tags: [api-surface, barrels, exports, modules, package-boundaries]
codeRefs: [src/index.ts, src/core/index.ts, src/knowledge/index.ts, src/work/index.ts, src/search/index.ts, src/orchestration/index.ts, src/migration/index.ts, src/ingest/index.ts, src/tools/index.ts, src/agents/index.ts, src/structure/index.ts, src/cli/index.ts, src/persistence/index.ts]
references: [monsthera-hybrid-knowledge-architecture-v6, adr-005-surface-boundaries]
createdAt: 2026-04-18T07:40:30.867Z
updatedAt: 2026-04-18T07:40:30.867Z
---

## Overview

Monsthera uses barrel files as public-module boundaries. They are not just convenience exports: they define which parts of a subsystem are meant to be imported externally and which parts remain leaf-level implementation details.

This matters when writing knowledge articles. Some docs should point to the leaf file that contains the behavior, while other docs should point to the barrel that defines the supported surface area.

## Root package entrypoint

`src/index.ts` is intentionally tiny. It exports:

- `VERSION`
- `createContainer` and `createTestContainer`
- config helpers `loadConfig` and `defaultConfig`
- container/config types

That file describes the package-level "start here" API for programmatic consumers.

## Domain barrels

Several subsystems expose curated barrels:

- `src/core/index.ts` re-exports the shared primitives: result, errors, types, logger, status, config, repository, lifecycle, container
- `src/knowledge/index.ts` exposes the knowledge domain public API
- `src/work/index.ts` exposes the work domain public API plus in-memory repository helpers
- `src/search/index.ts` exposes repository interfaces, tokenizer, embeddings, schemas, and service
- `src/orchestration/index.ts`, `src/ingest/index.ts`, and `src/migration/index.ts` serve the same role for their subsystems

## Specialized barrels

A few barrels are intentionally narrower:

- `src/structure/index.ts` exports only the structure service
- `src/agents/index.ts` exports the agent directory service and related types
- `src/cli/index.ts` exposes only the main router and a small subset of command handlers
- `src/tools/index.ts` aggregates every MCP tool family into one import surface
- `src/persistence/index.ts` is the stable surface around Dolt connection/schema/repository helpers

## Why this matters for traceability

When knowledge is meant to explain behavior, prefer the leaf implementation in `codeRefs`. When knowledge is meant to explain surface boundaries or integration contracts, prefer the barrel as well.

For example:

- use `src/search/service.ts` to explain ranking behavior
- use `src/search/index.ts` to explain what the search subsystem publicly exposes

That distinction keeps the wiki aligned with real module boundaries instead of flattening everything into file-by-file trivia.

## Relationship to other docs

The barrel story reinforces [[adr-005-surface-boundaries]] and gives a lower-level companion to [[monsthera-hybrid-knowledge-architecture-v6]] and [[cli-entrypoint-and-command-routing]].