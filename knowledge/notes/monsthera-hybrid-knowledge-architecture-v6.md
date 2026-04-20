---
id: k-ypsx5ask
title: Monsthera: Hybrid Knowledge Architecture v6
slug: monsthera-hybrid-knowledge-architecture-v6
category: architecture
tags: [architecture, container, result-pattern, search, embeddings, wiki, monsthera-v3]
codeRefs: [src/core/container.ts, src/core/config.ts, src/core/types.ts, src/core/result.ts, src/core/errors.ts, src/core/lifecycle.ts, src/core/status.ts, src/search/service.ts, src/search/embedding.ts, src/knowledge/service.ts, src/knowledge/wiki-bookkeeper.ts, src/context/insights.ts]
references: [searchservice-unified-search-indexing-and-context-packs, core-runtime-state-logging-and-startup-bootstrap, package-entrypoints-and-barrel-exports, wiki-surfaces-and-wikilink-semantics]
sourcePath: MonstheraV3/monsthera-architecture-v6-final.md
createdAt: 2026-04-10T23:03:46.170Z
updatedAt: 2026-04-18T07:40:31.136Z
---

## Overview

Monsthera is a TypeScript MCP server for AI agent coordination. This article describes the realized architecture of the v3 clean rewrite — how the codebase is structured, what patterns it uses, and how the major subsystems are wired together.

## Dependency Injection Container

The runtime is assembled in `createContainer()` (`src/core/container.ts`). It is a **manual DI container** — no framework, no decorators, just explicit wiring.

The `MonstheraContainer` interface exposes all services as readonly properties:

- `config` — validated `MonstheraConfig`
- `logger` / `status` — observability
- `knowledgeRepo` + `knowledgeService` — knowledge articles (FileSystem repo)
- `workRepo` + `workService` — work articles (FileSystem repo)
- `searchRepo` + `searchService` — search index (in-memory or Dolt)
- `orchestrationRepo` + `orchestrationService` — events (in-memory or Dolt)
- `structureService` — graph navigation
- `agentsService` — agent directory
- `ingestService` — local source import
- `migrationService` — optional v2 migration

**Wiring order matters.** SearchService is created first because KnowledgeService and WorkService both depend on it for `searchSync` (re-indexing on every create/update/delete). After both services exist, the container cross-wires them: `knowledgeService.setWorkRepo(workRepo)` and `workService.setKnowledgeRepo(knowledgeRepo)` — both need the opposite repo to rebuild the wiki `index.md`.

**Storage strategy:** Markdown files are always the source of truth for articles. The Dolt database (when enabled) only stores derived data: the search index and orchestration events. If Dolt is unavailable, the system falls back to in-memory repositories with a "degraded" health flag.

**Lifecycle:** A `DisposableStack` (`src/core/lifecycle.ts`) manages shutdown. Resources are disposed in LIFO order. The container's `dispose()` method triggers the stack, which closes Dolt pools, stops the orchestration loop, and cleans up any v2 reader.

## Result Pattern (Never Throws)

Every fallible operation returns `Result<T, E>` (`src/core/result.ts`) — a discriminated union:

```typescript
type Result<T, E = Error> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
```

Helper functions: `ok(value)`, `err(error)`, `unwrap(result)` (throws — used sparingly at boundaries), `mapResult()`, `flatMapResult()`.

The entire service layer, repository layer, and search layer use this pattern. No service method throws. Callers check `result.ok` before proceeding. This makes error paths explicit and composable.

## Error Hierarchy

All domain errors extend `MonstheraError` (`src/core/errors.ts`), which carries a typed `ErrorCode` string constant and optional `details` record:

- `ValidationError` — bad input / schema mismatch
- `NotFoundError` — entity not found (carries entity type + id)
- `AlreadyExistsError` — duplicate creation
- `StateTransitionError` — invalid phase transition (e.g. planning -> review)
- `StorageError` — persistence failure
- `ConfigurationError` — invalid config
- `GuardFailedError` — phase guard rejection
- `ConcurrencyConflictError` — file claim collision

Every error has a `.toResult<T>()` convenience method.

## Branded Types

`src/core/types.ts` uses TypeScript branded types to prevent ID mixing at compile time:

```typescript
type Brand<T, B extends string> = T & { readonly __brand: B };
type ArticleId = Brand<string, "ArticleId">;
type WorkId = Brand<string, "WorkId">;
type AgentId = Brand<string, "AgentId">;
type SessionId = Brand<string, "SessionId">;
type Slug = Brand<string, "Slug">;
type Timestamp = Brand<string, "Timestamp">;
```

Factory functions (`articleId()`, `workId()`, etc.) cast raw strings. `generateId(prefix)` creates random IDs like `k-dnd6o15p` or `w-abc12345`.

## Configuration

`MonstheraConfigSchema` (`src/core/config.ts`) uses **Zod v4** with defaults for every sub-schema:

- **Storage:** `markdownRoot` (default "knowledge"), optional Dolt connection
- **Search:** `semanticEnabled` (default true), `embeddingModel` (default "nomic-embed-text"), `alpha` (default 0.5 — BM25/semantic blend weight), `ollamaUrl`
- **Orchestration:** `autoAdvance`, `pollIntervalMs`, `maxConcurrentAgents`
- **Server:** `port`, `host`

`loadConfig()` reads JSON from `.monsthera/config.json`, merges env var overrides (`MONSTHERA_*`), validates with Zod, and returns `Result<MonstheraConfig, ConfigurationError>`.

## Search Architecture

See companion article for detailed ranking mechanics. High-level flow:

1. **BM25 keyword search** always runs against the inverted index
2. **Semantic search** (when enabled): query is embedded via Ollama (`nomic-embed-text`, 768 dims), then cosine similarity is computed against stored document embeddings
3. **Hybrid merge:** `finalScore = alpha * norm_bm25 + (1-alpha) * cosine` where alpha defaults to 0.5
4. **Trust reranking:** scores are adjusted based on legacy status, source paths, categories, and work phases
5. Results are paginated and returned

Embedding generation uses title + first 500 chars of content. The `StubEmbeddingProvider` (dimensions=0) disables semantic search gracefully — the service layer checks `dimensions > 0` before attempting embeddings.

## Context Pack Builder

`buildContextPack()` is the primary entry point for agents. It:

1. Runs a search with 3x the requested limit to get candidates
2. Fetches the full article for each hit
3. Runs `inspectKnowledgeArticle()` or `inspectWorkArticle()` to compute diagnostics (freshness, quality score)
4. Validates code refs against the filesystem (marks stale ones)
5. Computes a composite score combining search score, quality score, freshness, and mode-specific bonuses
6. Sorts by composite score, slices to the requested limit
7. Returns a `ContextPack` with summary statistics and mode-specific guidance strings

Modes (`general`, `code`, `research`) boost different signals — code mode rewards code refs and implementation-relevant categories; research mode rewards source paths, references, and spikes.

## Wiki Bookkeeper (Karpathy Second-Brain)

`WikiBookkeeper` (`src/knowledge/wiki-bookkeeper.ts`) maintains two files in the markdown root:

**`index.md`** — Full catalog rebuilt on every mutation:
- Knowledge articles grouped by category, sorted alphabetically, with relative links (`notes/<slug>.md`) and 80-char content snippets
- Work articles grouped by phase in lifecycle order (planning → done → cancelled), with priority badges and relative links (`work-articles/<id>.md`)
- Header shows total counts and last-updated timestamp

**`log.md`** — Append-only audit trail:
- Each entry: `- **[YYYY-MM-DD HH:MM:SS]** action type | Title (id)`
- Actions: create, update, delete, advance, reindex, archive
- File is created with a header on first write

The bookkeeper is injected into both KnowledgeService and WorkService. Every create/update/delete appends to the log and triggers a full index rebuild. The index rebuild needs both repos (knowledge + work), which is why the container cross-wires them after creation.

## Status Reporter

`StatusReporter` (`src/core/status.ts`) aggregates health checks from all subsystems. Each service registers a health check function at container creation time. `getStatus()` runs all checks and returns a `SystemStatus` with version, uptime, subsystem health array, and stat counters (article counts, index size, last reindex time).

## Key Design Principles

1. **Markdown is truth** — articles live as `.md` files; databases store only derived/ephemeral data
2. **Never throw** — `Result<T, E>` everywhere; errors are values, not control flow
3. **Explicit wiring** — no DI framework; the container function is readable top-to-bottom
4. **Graceful degradation** — Dolt unavailable? In-memory. Ollama down? BM25-only. Every subsystem has a fallback.
5. **Cross-cutting observability** — StatusReporter + Logger injected everywhere; health is always queryable

<!-- codex-related-articles:start -->
## Related Articles

- [[core-runtime-state-logging-and-startup-bootstrap]]
- [[package-entrypoints-and-barrel-exports]]
- [[wiki-surfaces-and-wikilink-semantics]]
- [[searchservice-unified-search-indexing-and-context-packs]]
<!-- codex-related-articles:end -->
