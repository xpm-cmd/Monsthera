---
id: k-klbt2h37
title: Dolt repositories: search index and orchestration events
slug: dolt-repositories-search-index-and-orchestration-events
category: context
tags: [dolt, search-index, orchestration-events, repositories, sql]
codeRefs: [src/persistence/dolt-search-repository.ts, src/persistence/dolt-orchestration-repository.ts, src/search/repository.ts, src/orchestration/repository.ts]
references: [k-2njgnd6v]
createdAt: 2026-04-11T02:27:05.577Z
updatedAt: 2026-04-11T02:27:05.577Z
---

## Overview

After Phase 3 cleanup, only two Dolt repository classes remain: `DoltSearchIndexRepository` and `DoltOrchestrationRepository`. These persist **derived data** (search indexes and event audit logs) to Dolt. Knowledge and work repositories were removed from Dolt — markdown files are the sole source of truth for those. The Dolt repos are instantiated only when `doltEnabled=true` and the connection/schema initialization succeeds; otherwise, in-memory implementations are used.

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
- **Dolt version**: documents and inverted index are persisted in SQL tables — survives restarts, supports concurrent access via connection pooling
- **In-memory version**: stores everything in Maps/Sets — lost on restart, single-process only
- **Embeddings are always in-memory**: Dolt has no native vector column type, so `DoltSearchIndexRepository` keeps embeddings in a `Map<string, number[]>` instance field. These are lost on restart regardless.

### Auxiliary methods

- **`removeArticle(id)`** — deletes from `search_inverted_index` first (FK constraint), then from `search_documents`, within a transaction. Also clears the in-memory `docTypes` and `embeddings` caches.
- **`reindex()`** — truncates `search_inverted_index`, reads all documents from `search_documents`, re-tokenizes each, and rebuilds the inverted index. Useful after tokenizer changes.
- **`clear()`** — truncates both tables within a transaction.
- **`canary()`** — counts documents, picks any term from the inverted index, runs a search, verifies it returns results. Returns `false` if documents exist but no search results come back (indicates index corruption).
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

## When each repository is used

Both Dolt repositories are instantiated in `src/core/container.ts` (lines 117-118) only when:
1. `config.storage.doltEnabled === true`
2. The dynamic import of the persistence module succeeds
3. `initializeSchema(doltPool)` returns `ok`

If any of these conditions fail, the container falls back to in-memory implementations for both search and orchestration.

## Why these are the ONLY Dolt repositories

Phase 3 cleanup removed `DoltKnowledgeRepository` and `DoltWorkRepository`. The rationale:
- **Markdown is the source of truth** for knowledge articles and work items. They live as `.md` files in the `knowledge/` directory, managed by filesystem-based repositories.
- **Search index is derived data** — it's rebuilt from markdown content. Persisting it in Dolt avoids expensive reindexing on every restart but losing it is non-catastrophic (just reindex).
- **Orchestration events are append-only audit logs** — they have no markdown equivalent and genuinely need a database for efficient querying by work ID, event type, and recency.

This split keeps the system simple: files for authoritative data, SQL for derived indexes and event streams.
