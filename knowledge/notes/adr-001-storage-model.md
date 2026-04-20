---
id: k-acodv9lb
title: ADR-001: Storage Model
slug: adr-001-storage-model
category: architecture
tags: [storage, persistence, markdown, dolt, file-system]
codeRefs: [src/knowledge/file-repository.ts, src/work/file-repository.ts, src/knowledge/markdown.ts, src/search/in-memory-repository.ts, src/persistence/index.ts, src/persistence/schema.ts, src/persistence/connection.ts, src/persistence/health.ts, src/core/container.ts]
references: []
sourcePath: docs/adrs/001-storage-model.md
createdAt: 2026-04-10T23:03:46.166Z
updatedAt: 2026-04-11T02:14:21.620Z
---

## Dual Storage Model

Monsthera uses a **dual storage architecture**: Markdown files are the source of truth for all knowledge and work articles, while an optional Dolt database (MySQL-compatible) stores only **derived data** (search indices and orchestration events).

### Layer 1: Markdown File System (Source of Truth)

All knowledge articles and work articles are persisted as Markdown files with YAML frontmatter. This is always active and has no external dependencies.

- **Knowledge articles** are stored in `{markdownRoot}/notes/{slug}.md` by `FileSystemKnowledgeArticleRepository`.
- **Work articles** are stored in `{markdownRoot}/work-articles/{id}.md` by `FileSystemWorkArticleRepository`.
- Both repos use the same `parseMarkdown()` / `serializeMarkdown()` functions from `src/knowledge/markdown.ts` to read/write frontmatter+body format.
- The `markdownRoot` is resolved from `config.storage.markdownRoot` relative to `config.repoPath`.

Each file uses the format:
```
---
id: k-abc123
title: Article Title
slug: article-title
category: decision
tags: [tag1, tag2]
codeRefs: [src/foo.ts]
references: []
createdAt: 2026-04-10T23:03:46.166Z
updatedAt: 2026-04-10T23:07:37.223Z
---

Markdown body content here.
```

### Layer 2: Dolt Database (Optional Derived Data)

When `config.storage.doltEnabled` is true, the container attempts to connect to a Dolt instance (MySQL-compatible) for **derived data only**:

- **Search index** (`DoltSearchIndexRepository`) — stores tokenized documents and an inverted index in `search_documents` and `search_inverted_index` tables.
- **Orchestration events** (`DoltOrchestrationRepository`) — stores agent audit trail in `orchestration_events` table.

Dolt never stores the canonical article content. It stores search tokens and event logs that can be rebuilt from the Markdown files at any time.

### Container Wiring (`src/core/container.ts`, lines 76-182)

The container always creates file-system repos first:
```
knowledgeRepo = new FileSystemKnowledgeArticleRepository(markdownRoot);
workRepo = new FileSystemWorkArticleRepository(markdownRoot);
```

Then, if `doltEnabled`:
1. Dynamically imports `../persistence/index.js` (keeps Dolt deps out of the critical path).
2. Creates a connection pool via `createDoltPool()`.
3. Runs `initializeSchema()` to ensure DDL tables exist (idempotent `CREATE TABLE IF NOT EXISTS`).
4. If schema init succeeds, creates `DoltSearchIndexRepository` and `DoltOrchestrationRepository`.
5. Starts `monitorDoltHealth()` — a 30-second polling interval that fires `onHealthChange` callbacks.
6. Registers two status checks: `"storage"` (combined description) and `"dolt-health"` (live latency/version).

### Fallback Behavior

If Dolt is unavailable or initialization fails, the system **falls back gracefully**:

1. **Schema init failure** — logs a warning, closes the pool, sets `doltPool = undefined`, and falls through.
2. **Import/connection failure** — catches the error, logs a warning, and falls through.
3. **Fallback repos** — if `searchRepo` is still undefined after the Dolt block, the container creates `InMemorySearchIndexRepository` and `InMemoryOrchestrationEventRepository`.
4. **Degraded status** — when Dolt was enabled but failed, the storage status check reports `healthy: false` with detail `"degraded — Dolt unavailable"`. When Dolt was never enabled, it simply reports the Markdown root.

This means the system **always starts successfully** — the only hard requirement is a writable filesystem for Markdown files. Search and orchestration work in-memory when Dolt is absent, with the trade-off that search indices are lost on restart (they get rebuilt from Markdown on startup via reindex).

### Schema (Dolt DDL)

Three tables defined in `src/persistence/schema.ts`:
- `search_documents` — id, title, content, type, indexed_at
- `search_inverted_index` — term-to-document mapping (composite PK: term + doc_id)
- `orchestration_events` — work_id, event_type, agent_id, details (JSON), created_at

### Connection Management

`src/persistence/connection.ts` provides:
- `createDoltPool()` — MySQL2 connection pool with keepalive enabled
- `executeQuery()` / `executeMutation()` — Result-wrapped query helpers
- `executeTransaction()` — auto BEGIN/COMMIT/ROLLBACK with connection release in `finally`
- All functions return `Result<T, StorageError>` for uniform error handling