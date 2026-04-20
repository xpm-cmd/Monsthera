---
id: k-qszeow1i
title: SearchService: Unified search, indexing, and context packs
slug: searchservice-unified-search-indexing-and-context-packs
category: context
tags: [search-service, indexing, embeddings, context-packs, health]
codeRefs: [src/search/service.ts, src/search/repository.ts, src/search/schemas.ts, src/search/embedding.ts, src/search/tokenizer.ts, src/search/sync.ts, src/core/runtime-state.ts]
references: [core-runtime-state-logging-and-startup-bootstrap, wiki-surfaces-and-wikilink-semantics, in-memory-repositories-and-degraded-mode-fallbacks]
createdAt: 2026-04-11T02:25:11.764Z
updatedAt: 2026-04-18T07:40:31.197Z
---

## Overview

`SearchService` is the central search coordinator in Monsthera. It owns the full search lifecycle: indexing articles into BM25, generating and storing semantic embeddings, executing hybrid search queries, building context packs, health monitoring, and runtime state persistence. It lives at `src/search/service.ts`.

This article is the service-level overview. For detailed coverage of individual subsystems, see the existing articles on BM25 scoring, search ranking, and context packs.

## Dependencies

The `SearchServiceDeps` interface wires in:

- **SearchIndexRepository** — the BM25 inverted index with document storage, search, reindex, canary check, and vector storage/search (`src/search/repository.ts`)
- **KnowledgeArticleRepository** — fetches knowledge articles for indexing and context pack enrichment
- **WorkArticleRepository** — fetches work articles for indexing and context pack enrichment
- **EmbeddingProvider** — generates vector embeddings for semantic search (`src/search/embedding.ts`)
- **MonstheraConfig["search"]** — search configuration including `semanticEnabled` and `alpha` (BM25/semantic weight)
- **Logger** — child logger tagged with `{ domain: "search" }`
- **StatusReporter** (optional) — records runtime stats like `searchIndexSize`, `lastReindexAt`, `embeddingCount`
- **RuntimeStateStore** (optional) — persists state across server restarts
- **repoPath** (optional) — repository root for validating code refs on disk

## Public methods

### `search(input): Promise<Result<SearchResult[], ValidationError | StorageError>>`

The primary search entry point. Accepts raw input validated via `validateSearchInput()` (Zod schema in `src/search/schemas.ts`). Query parameters: `query` (required, trimmed, min length 1), `type` (optional: "knowledge" | "work" | "all"), `limit` (1-100, default 20), `offset` (default 0).

Execution flow:
1. **BM25 keyword search** — always runs via `searchRepo.search()` with `limit * 3` candidates
2. **Semantic search** (conditional) — runs only when `semanticEnabled` is true, embedding provider has `dimensions > 0`, and the index has stored embeddings. Embeds the query via `embeddingProvider.embed(query)`, then calls `searchRepo.searchSemantic()`.
3. **Hybrid merge** — `mergeResults()` normalizes BM25 scores to [0,1], then combines: `finalScore = alpha * norm_bm25 + (1 - alpha) * cosine`. The `alpha` parameter controls the BM25 vs semantic weight.
4. **Trust reranking** — `rerankForTrust()` adjusts scores based on article properties. Legacy articles (detected by `isLegacyKnowledgeArticle`/`isLegacyWorkArticle`) are penalized (-1.2 for knowledge, -1.1 for work). Source-linked knowledge gets +0.45. Active work phases get +0.2. Architectural categories get +0.15. Legacy queries bypass reranking entirely.
5. Results with score <= 0 are filtered out (unless all results are non-positive, in which case all are kept).

Falls back gracefully: if semantic embedding fails or is unavailable, returns BM25-only results.

### `buildContextPack(input): Promise<Result<ContextPack, ValidationError | StorageError>>`

Builds a rich context pack for AI agent consumption. Modes: `"general"`, `"code"`, `"research"`.

1. Runs `search()` internally with `candidateLimit = max(limit * 3, 12)` to get a broad candidate pool
2. For each search hit, fetches the full article and runs diagnostics:
   - Knowledge articles: `inspectKnowledgeArticle()` for freshness and quality scoring
   - Work articles: `inspectWorkArticle()` for the same
3. Validates code refs against the filesystem (if `repoPath` is set), separating valid from stale refs
4. Computes a composite score via `scoreContextPackItem()` which adjusts the base search score with:
   - Quality score contribution (`qualityScore / 40`)
   - Freshness bonus/penalty (+0.5 fresh, +0.2 attention, -0.25 stale)
   - Mode-specific boosts: code mode favors code refs (+0.35 each, max +1.2) and architecture/engineering categories; research mode favors references, source paths, and spike templates
5. Generates mode-specific `guidance[]` strings advising the agent how to use the pack
6. Skips stale index entries (articles that exist in the search index but were deleted from the repository), counting them in `skippedStaleIndexCount`

The `ContextPack` response includes a `summary` with counts (items, knowledge, work, fresh, stale, code-linked, source-linked) and the sorted `items[]`.

### `fullReindex(): Promise<Result<{ knowledgeCount, workCount }, StorageError>>`

Complete index rebuild. This is the only method that regenerates everything:

1. Fetches all knowledge and work articles
2. Upserts each article into the search index (upsert semantics — no clear-and-rebuild, keeps index queryable throughout)
3. Calls `searchRepo.reindex()` to rebuild inverted index structures
4. If semantic search is enabled, generates embeddings for all articles (checks provider health first)
5. Records stats to StatusReporter and persists to RuntimeStateStore: `knowledgeArticleCount`, `workArticleCount`, `searchIndexSize`, `lastReindexAt`
6. Runs a canary check at the end to verify the index is functional

Note: orphan removal (stale entries for deleted articles) is NOT performed during reindex — use `removeArticle()` explicitly.

### `indexKnowledgeArticle(id): Promise<Result<void, NotFoundError | StorageError>>`

Indexes a single knowledge article. Fetches it from the knowledge repo, builds index content (article content + code refs appended), indexes via BM25, and generates+stores an embedding if semantic search is enabled. Called by `SearchMutationSync` after knowledge CRUD operations.

### `indexWorkArticle(id): Promise<Result<void, NotFoundError | StorageError>>`

Same as above but for work articles. Called by `SearchMutationSync` after work CRUD operations.

### `removeArticle(id): Promise<Result<void, StorageError>>`

Removes an article from the search index by id. Called by `SearchMutationSync` after article deletion.

### `getHealthStatus(): { healthy: boolean; detail: string }`

Synchronous health check returning current status. Reports index size, embedding count, and canary state. An empty index is always healthy. A non-empty index with a failed canary reports unhealthy.

### `runCanary(): Promise<boolean>`

Executes a canary query against the search repository. Caches the result in `canaryHealthy`. Logs a warning if the canary fails (index has documents but queries return empty).

## The SearchMutationSync interface

Defined in `src/search/sync.ts`, this is a minimal 3-method interface:

```typescript
interface SearchMutationSync {
  indexKnowledgeArticle(id: string): Promise<Result<void, NotFoundError | StorageError>>;
  indexWorkArticle(id: string): Promise<Result<void, NotFoundError | StorageError>>;
  removeArticle(id: string): Promise<Result<void, StorageError>>;
}
```

`SearchService` implements this interface. Other services (KnowledgeService, WorkService) receive a `SearchMutationSync` dependency and call it after every create/update/delete operation. This keeps the search index in sync without those services depending on the full `SearchService`. The interface lives in its own file to avoid circular imports.

## Embedding providers

The `EmbeddingProvider` interface (`src/search/embedding.ts`) defines:
- `embed(text)` — single text to vector
- `embedBatch(texts)` — batch embedding (sequential in Ollama implementation)
- `healthCheck()` — verifies provider reachability and model availability
- `dimensions` — vector dimensionality (0 means disabled)
- `modelName` — model identifier

Two implementations:

- **StubEmbeddingProvider** — returns empty arrays, `dimensions = 0`. The service checks `dimensions > 0` to skip the semantic path entirely. Used when semantic search is not configured.
- **OllamaEmbeddingProvider** — calls Ollama's `/api/embeddings` endpoint. Default model is `nomic-embed-text` with 768 dimensions. Health check verifies Ollama is reachable via `/api/tags` and the specified model is installed.

The service embeds a concise representation: `title + first 500 chars of content`.

## BM25 tokenizer

The tokenizer (`src/search/tokenizer.ts`) is simple and deterministic:

1. Lowercase the input
2. Split on non-alphanumeric characters (`/[^a-z0-9]+/`)
3. Filter empty strings and Lucene default English stop words (36 words: a, an, and, are, as, at, be, but, by, for, if, in, into, is, it, no, not, of, on, or, such, that, the, their, then, there, these, they, this, to, was, will, with)

CamelCase is not explicitly split at the tokenizer level — the split-on-non-alphanumeric handles it when terms are separated by punctuation or spaces in the source content.

## Validation schemas

`src/search/schemas.ts` uses Zod v4 to validate search input:
- `query`: string, min 1 char, trimmed
- `type`: optional enum ("knowledge" | "work" | "all")
- `limit`: optional int, 1-100
- `offset`: optional int, >= 0

The `validateSearchInput()` function wraps Zod parsing into Monsthera's `Result<SearchInput, ValidationError>` pattern.

## Health monitoring

The service uses a canary document pattern:
- `runCanary()` executes a test query against the search repo's `canary()` method
- Result is cached in `canaryHealthy` (null = never ran, true/false = last result)
- `getHealthStatus()` returns a status string including index size, embedding count, and canary state
- The canary runs automatically at the end of `fullReindex()`

## Runtime state persistence

After `fullReindex()`, the service persists key metrics to `RuntimeStateStore`:
- `knowledgeArticleCount`
- `workArticleCount`
- `searchIndexSize`
- `lastReindexAt`

These survive server restarts so the status page can report last-known state before the first reindex completes.

## Index content construction

`buildIndexContent()` appends code refs to article content: `content + "\n" + codeRefs.join(" ")`. This makes code ref paths searchable via BM25 — searching for a file path will match articles that reference it.

## Code ref validation

During context pack building, `validateCodeRefs()` checks each code ref path against the filesystem (using `resolveCodeRef()` + `fs.existsSync()`). Stale refs (files that no longer exist) are separated and reported in the context pack item's `staleCodeRefs` field.

<!-- codex-related-articles:start -->
## Related Articles

- [[core-runtime-state-logging-and-startup-bootstrap]]
- [[wiki-surfaces-and-wikilink-semantics]]
- [[in-memory-repositories-and-degraded-mode-fallbacks]]
- [[context-pack-builder-scoring-diagnostics-and-mode-specific-ranking]]
<!-- codex-related-articles:end -->
