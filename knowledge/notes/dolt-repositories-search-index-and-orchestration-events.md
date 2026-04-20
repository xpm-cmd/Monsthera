---
id: k-klbt2h37
title: Dolt repositories: search index and orchestration events
slug: dolt-repositories-search-index-and-orchestration-events
category: context
tags: [dolt, search-index, orchestration-events, repositories, sql]
codeRefs: [src/persistence/dolt-search-repository.ts, src/persistence/dolt-orchestration-repository.ts, src/persistence/dolt-snapshot-repository.ts, src/search/repository.ts, src/orchestration/repository.ts, src/context/snapshot-repository.ts]
references: [k-2njgnd6v]
createdAt: 2026-04-11T02:27:05.577Z
updatedAt: 2026-04-20T00:00:00.000Z
---

## Overview

There are now three Dolt repository classes: `DoltSearchIndexRepository`, `DoltOrchestrationRepository`, and `DoltSnapshotRepository`. These persist **derived or auxiliary data** — the search index (documents, inverted index, and embedding vectors), the orchestration event audit log, and environment snapshots captured from agent sandboxes. Knowledge and work repositories were removed from Dolt in Phase 3 cleanup — markdown files are the sole source of truth for those. The Dolt repos are instantiated only when `doltEnabled=true` and the connection/schema initialization succeeds; otherwise, in-memory implementations are used.

## DoltSearchIndexRepository (`src/persistence/dolt-search-repository.ts`)

Implements the `SearchIndexRepository` interface defined in `src/search/repository.ts`.

### Interface contract

The `SearchIndexRepository` interface requires:
- `indexArticle(id, title, content, type)` — add/update a document in the index
- `removeArticle(id)` — remove a document
- `search(options: SearchOptions)` — BM25 keyword search with type filtering, pagination
- `reindex()` — rebuild all derived index structures from stored documents
- `clear()` — remove everything
- `size` — document count
- `canary()` — smoke test: verify the index can actually return results
- `storeEmbedding(id, embedding)` — store a vector for semantic search
- `searchSemantic(queryEmbedding, limit, type?)` — cosine similarity search
- `embeddingCount` — number of stored vectors

### How indexing works: `indexArticle`

Uses a manual transaction (not `executeTransaction`):

1. Acquires a connection from the pool, begins transaction
2. **Upserts** into `search_documents` using `INSERT ... ON DUPLICATE KEY UPDATE` — updates title, content, type, and indexed_at if the document already exists
3. **Deletes** all existing `search_inverted_index` rows for this doc_id (clean slate)
4. **Tokenizes** the title and content using the shared `tokenize()` function from `src/search/tokenizer.ts`
5. **Deduplicates** tokens into a `Set`, then inserts each unique `(term, doc_id)` pair into `search_inverted_index` with `ON DUPLICATE KEY UPDATE doc_id = doc_id` (no-op on collision)
6. Commits the transaction; caches the doc type in `this.docTypes` Map
7. On error: rolls back and returns `StorageError`
8. Always releases the connection in `finally`

### How search works: BM25-lite scoring

The `search(options)` method implements a multi-step BM25 search:

1. **Tokenize query** — if no valid tokens, returns empty results
2. **Find candidates** — queries `search_inverted_index` for all `doc_id`s matching any query term (`WHERE term IN (...)`)
3. **Fetch documents** — loads full `search_documents` rows for all candidate IDs
4. **Get corpus stats** — `SELECT COUNT(*) FROM search_documents` for total document count (N, used in IDF)
5. **Get document frequencies** — `getDocumentFrequencies(queryTerms)` queries `search_inverted_index` grouped by term to get how many documents contain each term
6. **Score each candidate** with `bm25Score()`:
   - Computes term frequencies from the combined title+content token stream
   - For each query term: `saturatedTf = tf / (tf + K1)` where K1=1.2
   - IDF = `log((N - df + 0.5) / (df + 0.5) + 1)`
   - **Title boost**: terms appearing in the title get a 3x multiplier (`TITLE_BOOST = 3.0`)
   - Final score = sum of `saturatedTf * idf * fieldBoost` across all query terms
7. **Sort** by score descending, apply `offset` and `limit` pagination
8. **Generate snippets** — finds first occurrence of any query term in content, extracts ~160 chars centered around it (80-char radius). Falls back to first 160 chars if no term found in content.

### How it differs from InMemorySearchIndexRepository

Both implement the same `SearchIndexRepository` interface, but:
- **Dolt version**: documents, inverted index, and embedding vectors are persisted in SQL tables — survives restarts, supports concurrent access via connection pooling
- **In-memory version**: stores everything in Maps/Sets — lost on restart, single-process only

### Embedding persistence (restart-safe semantic search)

Dolt has no native vector column type, so vectors are stored as JSON strings and hydrated into an in-memory `Map<string, number[]>` on demand. The repo tracks two caches — `embeddings` (id → vector) and `docTypes` (id → knowledge|work) — plus a hydration flag (`embeddingCacheHydrated`) and a cached count (`cachedEmbeddingCount`).

- **`storeEmbedding(id, embedding)`** — `INSERT ... ON DUPLICATE KEY UPDATE` against `search_embeddings` with the vector serialized via `JSON.stringify(embedding)` and `updated_at = CURRENT_TIMESTAMP`. Updates the in-memory cache; if the cache hasn't been hydrated yet, it refreshes `cachedEmbeddingCount` from `SELECT COUNT(*) FROM search_embeddings`.
- **`searchSemantic(queryEmbedding, limit, type?)`** — calls `ensureEmbeddingCacheLoaded()` first, then computes cosine similarity against every cached vector (filtered by `docTypes` when `type` is set), sorts descending, and returns the top `limit`.
- **`embeddingCount`** getter — returns `cachedEmbeddingCount` without hitting the database.
- **`ensureEmbeddingCacheLoaded()`** (private) — runs once per process: joins `search_embeddings` with `search_documents` to fetch `(doc_id, type, embedding_json)` rows, parses each vector with `parseEmbeddingJson` (rejects non-number-array payloads), and populates both caches. Parse failures on individual rows are skipped silently; a query-level error clears the caches and resets the count to 0.
- Lifecycle hooks: `removeArticle` also `DELETE`s from `search_embeddings` inside the same transaction and evicts the id from the in-memory cache; `clear()` truncates `search_embeddings` alongside the other tables and resets the cache as hydrated-empty; `canary()` calls `ensureEmbeddingCacheLoaded()` so the count is warm before it's observed.

This is the core of the v3.0.0-alpha.6 WIP: embeddings now survive restarts because they live in Dolt as LONGTEXT JSON, and the hydration path reloads them lazily on first semantic query or canary check.

### Auxiliary methods

- **`removeArticle(id)`** — deletes from `search_inverted_index` first (FK constraint), then from `search_documents` and `search_embeddings`, all within a transaction. Also clears the in-memory `docTypes` and `embeddings` caches and refreshes the embedding count.
- **`reindex()`** — truncates `search_inverted_index`, reads all documents from `search_documents`, re-tokenizes each, and rebuilds the inverted index. Useful after tokenizer changes.
- **`clear()`** — truncates `search_inverted_index`, `search_embeddings`, and `search_documents` within a transaction, then resets the in-memory caches.
- **`canary()`** — counts documents, warms the embedding cache, picks any term from the inverted index, runs a search, verifies it returns results. Returns `false` if documents exist but no search results come back (indicates index corruption).
- **`size`** — returns `cachedSize`, updated by `canary()`. This is a cached value, not a live query.

## DoltOrchestrationRepository (`src/persistence/dolt-orchestration-repository.ts`)

Implements the `OrchestrationEventRepository` interface defined in `src/orchestration/repository.ts`.

### Interface contract

```typescript
interface OrchestrationEventRepository {
  logEvent(event: Omit<OrchestrationEvent, "id" | "createdAt">): Promise<Result<OrchestrationEvent, StorageError>>;
  findByWorkId(workId: WorkId): Promise<Result<OrchestrationEvent[], StorageError>>;
  findByType(type: OrchestrationEventType): Promise<Result<OrchestrationEvent[], StorageError>>;
  findRecent(limit: number): Promise<Result<OrchestrationEvent[], StorageError>>;
}
```

### Event types

Seven orchestration event types are defined:
- `phase_advanced` — work item moved to next phase
- `agent_spawned` — new agent started working
- `agent_completed` — agent finished its task
- `dependency_blocked` — work blocked on a dependency
- `dependency_resolved` — blocking dependency cleared
- `guard_evaluated` — a phase guard was evaluated
- `error_occurred` — something went wrong

### How events are stored: `logEvent`

1. Generates a unique ID with `generateId("evt")` prefix
2. Creates a timestamp with `timestamp()`
3. Inserts into `orchestration_events` using `executeMutation` (the shared helper from connection.ts, not a manual transaction)
4. Serializes `event.details` as `JSON.stringify()` for the JSON column
5. Handles nullable `agentId` (sets to `null` if absent)
6. Returns the full `OrchestrationEvent` with generated id and createdAt

### Query patterns

All queries use `executeQuery` and return `Result<OrchestrationEvent[], StorageError>`:

- **`findByWorkId(workId)`** — `WHERE work_id = ? ORDER BY created_at ASC` — chronological order for a single work item's history
- **`findByType(type)`** — `WHERE event_type = ? ORDER BY created_at DESC` — most recent first, useful for finding latest events of a kind
- **`findRecent(limit)`** — `ORDER BY created_at DESC LIMIT ?` — global recent events across all work items

### Row parsing: `parseEventRow`

Private method that converts SQL rows back to domain objects:
- Parses `details` from JSON string to `Record<string, unknown>` (handles both string and pre-parsed object forms)
- Wraps `work_id` with `workId()` branded type constructor
- Wraps `agent_id` with `agentId()` branded type constructor (if non-null)
- Wraps `created_at` with `timestamp()` branded type constructor

### Design: no transactions needed

Unlike the search repository, the orchestration repository uses simple single-statement operations via `executeMutation`/`executeQuery` — no transactions required since each operation is a single INSERT or SELECT.

## DoltSnapshotRepository (`src/persistence/dolt-snapshot-repository.ts`)

Implements the `SnapshotRepository` interface defined in `src/context/snapshot-repository.ts`. Persists **environment snapshots** — the physical sandbox state (cwd, git ref, file listing, runtimes, package managers, lockfile hashes, memory, optional raw probe output) that the caller gathers from its own harness and passes in; Monsthera itself never runs shell commands. This lets `build_context_pack` attach the latest snapshot for a given agent or work article alongside the semantic ranking.

### What it persists

One row per snapshot in the `environment_snapshots` table. The JSON columns (`git_ref`, `files`, `runtimes`, `package_managers`, `lockfiles`, `memory`) are written via `JSON.stringify` during insert. The `decodeJson` helper used by `parseRow` defensively handles either already-parsed objects or raw strings on read, depending on how the `mysql2` driver returns JSON columns.

### Key methods

- **`record(input)`** — generates an id with `generateId("s")` and a millisecond-precision `timestamp()`, then performs a single `executeMutation` INSERT into `environment_snapshots`. Nullable fields (`workId`, `gitRef`, `memory`, `raw`) fall back to SQL `NULL`. Returns the stored `EnvironmentSnapshot` (including id and capturedAt).
- **`findById(id)`** — `SELECT * FROM environment_snapshots WHERE id = ? LIMIT 1`. Returns `NotFoundError` when no row matches, otherwise the parsed snapshot.
- **`findLatestByAgent(agentId)`** — `WHERE agent_id = ? ORDER BY captured_at DESC LIMIT 1`. Returns `null` (not an error) when no snapshot exists for that agent.
- **`findLatestByWork(workId)`** — same pattern, filtered by `work_id`. Used by the context-pack integration: `workId` is preferred over `agentId` when both are supplied.
- **`findAllByWork(workId)`** — chronological history of all snapshots for a single work article (`ORDER BY captured_at ASC`).

### No transactions

Like the orchestration repo, each operation is a single INSERT or SELECT, so `record`/`find*` use the shared `executeMutation`/`executeQuery` helpers without explicit transaction management.

## When each repository is used

All three Dolt repositories are instantiated in `src/core/container.ts` only when:
1. `config.storage.doltEnabled === true`
2. The dynamic import of the persistence module succeeds
3. `initializeSchema(doltPool)` returns `ok`

If any of these conditions fail, the container falls back to in-memory implementations for search, orchestration, and snapshots.

## Why these are the Dolt repositories

Phase 3 cleanup removed `DoltKnowledgeRepository` and `DoltWorkRepository`. The rationale:
- **Markdown is the source of truth** for knowledge articles and work items. They live as `.md` files in the `knowledge/` directory, managed by filesystem-based repositories.
- **Search index is derived data** — documents, inverted index, and embedding vectors are rebuilt from markdown content. Persisting them in Dolt (embeddings as LONGTEXT JSON, since Dolt has no vector column) avoids expensive reindexing and re-embedding on every restart, but losing them is non-catastrophic (just reindex / re-embed).
- **Orchestration events are append-only audit logs** — they have no markdown equivalent and genuinely need a database for efficient querying by work ID, event type, and recency.
- **Environment snapshots are ephemeral sandbox captures** — short-lived, queried by latest-per-(agent, work), and paired with work articles for drift detection. A database is the right fit for time-ordered lookups and the `compare_environment_snapshots` tool.

This split keeps the system simple: files for authoritative data, SQL for derived indexes, event streams, and sandbox state.
