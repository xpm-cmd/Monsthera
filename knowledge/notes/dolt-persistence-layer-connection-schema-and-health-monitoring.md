---
id: k-2njgnd6v
title: Dolt persistence layer: connection, schema, and health monitoring
slug: dolt-persistence-layer-connection-schema-and-health-monitoring
category: context
tags: [dolt, persistence, connection-pool, schema, health-monitoring, mysql]
codeRefs: [src/persistence/connection.ts, src/persistence/schema.ts, src/persistence/health.ts, src/persistence/index.ts, src/core/container.ts]
references: []
createdAt: 2026-04-11T02:26:06.609Z
updatedAt: 2026-04-11T02:26:06.609Z
---

## Overview

Monsthera uses Dolt (a MySQL-compatible version-controlled database) as an optional persistence backend for derived data — specifically the search index and orchestration events. The persistence module lives in `src/persistence/` and is only loaded when `doltEnabled=true` in the storage config. Markdown files remain the source of truth for knowledge and work articles; Dolt stores only derived/computed data.

## Connection pool (`src/persistence/connection.ts`)

The module uses `mysql2/promise` to create a standard MySQL connection pool, since Dolt speaks the MySQL wire protocol.

### `createDoltPool(config: DoltConnectionConfig): Pool`

Creates a pool with these settings:
- `host`, `port`, `database` from config (required)
- `user` defaults to `"root"`, `password` defaults to `""` (typical Dolt local dev setup)
- `connectionLimit` defaults to `10`
- `waitForConnections: true` — callers block rather than fail when the pool is exhausted
- `enableKeepAlive: true`, `keepAliveInitialDelay: 0` — prevents idle connection drops

### Query helpers

All query helpers wrap results in `Result<T, StorageError>` (the project's railway-oriented error type):

- **`executeQuery(pool, sql, params?)`** — runs a SELECT via `pool.execute<RowDataPacket[]>`. Returns `ok(rows)` or `err(StorageError)`.
- **`executeMutation(pool, sql, params?)`** — runs INSERT/UPDATE/DELETE via `pool.execute<ResultSetHeader>`. Returns `ok(header)` or `err(StorageError)`.
- **`getConnection(pool)`** — acquires a single `PoolConnection` from the pool. Caller must release it. Returns `Result<PoolConnection, StorageError>`.
- **`closePool(pool)`** — calls `pool.end()`, waits for all active connections to finish.

### Transaction support: `executeTransaction<T>(pool, fn)`

Provides automatic BEGIN/COMMIT/ROLLBACK:

1. Acquires a connection via `getConnection`
2. Calls `connection.beginTransaction()`
3. Passes the connection to the caller's `fn(connection)` callback — the caller runs all queries on this connection to keep them in the same transaction
4. On success: `connection.commit()`, returns `ok(result)`
5. On error: `connection.rollback()`, returns `err(StorageError)`. If rollback itself fails, returns the rollback error instead
6. Always releases the connection in `finally`

Note: The Dolt repository classes (`DoltSearchIndexRepository`, `DoltOrchestrationRepository`) manage their own transactions directly rather than using `executeTransaction`, calling `connection.beginTransaction()`/`commit()`/`rollback()` explicitly on connections obtained from the pool.

## Schema (`src/persistence/schema.ts`)

### Three DDL tables (post-Phase 3 cleanup)

After Phase 3, only three tables remain. Knowledge and work tables were removed because markdown is the source of truth.

**1. `search_documents`** — stores the full content of indexed articles for full-text search:
- `id VARCHAR(255) PRIMARY KEY` — article ID
- `title VARCHAR(255) NOT NULL`
- `content LONGTEXT NOT NULL` — full article body
- `type VARCHAR(50) NOT NULL` — `"knowledge"` or `"work"`
- `indexed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
- Indexes: `idx_type(type)`, `idx_indexed_at(indexed_at)`

**2. `search_inverted_index`** — term-to-document mapping for BM25 search:
- `term VARCHAR(255) NOT NULL` — a tokenized term
- `doc_id VARCHAR(255) NOT NULL` — FK to `search_documents(id)`
- `PRIMARY KEY (term, doc_id)` — composite key, one row per unique term-document pair
- Index: `idx_doc_id(doc_id)` — enables fast deletion of all terms for a document

**3. `orchestration_events`** — audit trail of agent actions:
- `id INT AUTO_INCREMENT PRIMARY KEY`
- `work_id VARCHAR(255) NOT NULL` — which work item this event relates to
- `event_type VARCHAR(100) NOT NULL` — e.g. `phase_advanced`, `agent_spawned`, `error_occurred`
- `agent_id VARCHAR(255)` — nullable, which agent performed the action
- `details JSON NOT NULL DEFAULT '{}'` — arbitrary event payload
- `created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP`
- Indexes: `idx_work_id`, `idx_event_type`, `idx_agent_id`, `idx_created_at`

### `initializeSchema(pool): Promise<Result<void, StorageError>>`

Iterates over `SCHEMA_STATEMENTS` and executes each DDL statement. Every statement uses `CREATE TABLE IF NOT EXISTS`, making the function fully idempotent — safe to call on every startup. If any single statement fails, it returns early with a `StorageError` containing the failing statement.

## Health monitoring (`src/persistence/health.ts`)

### `DoltHealthStatus` interface

```typescript
{ healthy: boolean; latencyMs: number; version?: string; error?: string }
```

### `checkDoltHealth(pool): Promise<DoltHealthStatus>`

One-shot health probe:
- Executes `SELECT VERSION() as version`
- Measures round-trip latency in milliseconds
- Returns `{ healthy: true, latencyMs, version }` on success
- Returns `{ healthy: false, latencyMs, error }` on failure

### `monitorDoltHealth(pool, options?): () => void`

Continuous background monitor:
- Polls `checkDoltHealth` every `intervalMs` (default 30,000ms / 30 seconds)
- Tracks the last known `isHealthy` state
- Calls `onHealthChange(status)` only when the health state transitions (healthy→unhealthy or vice versa, or error message changes)
- Returns a cleanup function that calls `clearInterval` to stop monitoring

## Container wiring (`src/core/container.ts`, lines 87-161)

The persistence module is loaded conditionally via dynamic `import()`:

### Initialization flow

1. **Guard**: only runs if `config.storage.doltEnabled === true`
2. **Dynamic import**: `await import("../persistence/index.js")` — keeps the mysql2 dependency out of the bundle when Dolt is disabled
3. **Pool creation**: `createDoltPool({ host, port, database, user, password })` from config
4. **Schema init**: `initializeSchema(doltPool)` — creates tables if they don't exist
5. **On schema failure**: logs a warning, calls `closePool(doltPool)`, sets `doltPool = undefined`, falls through to in-memory storage (no crash)
6. **On success**:
   - Creates `DoltSearchIndexRepository(doltPool)` for search
   - Creates `DoltOrchestrationRepository(doltPool)` for events
   - Registers `closePool` on the cleanup stack (`stack.defer`)
   - Registers two status checks: `"storage"` (general) and `"dolt-health"` (from monitor)
   - Starts `monitorDoltHealth` with `onHealthChange` callback that updates the status detail string
   - Registers the monitor's stop function on the cleanup stack
7. **On import/init exception**: catches any error, logs warning, falls through to in-memory — the entire Dolt block is wrapped in try/catch

### Graceful fallback chain

The design ensures Monsthera always starts, even without Dolt:
- `doltEnabled=false` → skips the entire block, uses in-memory repos
- `doltEnabled=true` but import fails → catch block, falls back to in-memory
- `doltEnabled=true` but schema init fails → closes pool, falls back to in-memory
- `doltEnabled=true` and init succeeds → uses Dolt repos for search + events

Knowledge and work repositories always use the filesystem (markdown). The comment in container.ts makes this explicit: "Knowledge and Work repos stay FileSystem — Markdown is the source of truth. Only search index and orchestration events (derived data) move to Dolt."

## Barrel exports (`src/persistence/index.ts`)

The public API exposes:
- **Connection**: `createDoltPool`, `closePool`, `executeQuery`, `executeMutation`, `getConnection`, `executeTransaction`, plus `DoltConnectionConfig` type
- **Schema**: `initializeSchema`, `SCHEMA_STATEMENTS`
- **Health**: `checkDoltHealth`, `monitorDoltHealth`, plus `DoltHealthStatus` type
- **Repositories**: `DoltSearchIndexRepository`, `DoltOrchestrationRepository` — the only two Dolt repository classes remaining after Phase 3 cleanup
