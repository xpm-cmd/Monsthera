# Phase 9: Hardening

## Goal
Harden Monsthera v3 for production readiness: error resilience, input validation at boundaries, graceful degradation, logging coverage, and operational observability.

## Context
Phases 1-8 built the full feature set: core types, knowledge/work/search/orchestration modules, persistence, surfaces (CLI/MCP/dashboard), and v2 migration. Phase 9 makes it production-grade.

## CHECK STATE FIRST
```bash
git checkout rewrite/v3 2>/dev/null; git status && git log --oneline -5
pnpm test 2>&1 | tail -5
pnpm typecheck 2>&1 | tail -5
```

## Tasks

### 1. Input validation hardening
- Audit all MCP tool handlers in `src/tools/` for missing input validation
- Ensure every `requireString`/`optionalString` pattern is consistent
- Add length limits and format checks where missing (e.g., title max length, ID format)
- Validate enum values exhaustively (no fallthrough to default cases without error)

### 2. Error propagation audit
- Trace every `Result<T, E>` chain from repository → service → tool handler
- Ensure no error is silently swallowed (every `!result.ok` branch either returns or logs)
- Add structured error context (entity type, ID, operation) to all error paths
- Verify `StorageError` wrapping in all Dolt repository methods

### 3. Graceful degradation
- Container should start in degraded mode if Dolt is unreachable (fall back to in-memory with warning)
- Search should work without embeddings (pure FTS5 fallback when Ollama is down)
- Migration should handle partial v2 data gracefully (missing verdicts, null fields)
- Dashboard should render even if some services are unhealthy

### 4. Logging coverage
- Ensure every service method logs entry (info) and error (error) paths
- Add operation timing for slow-path operations (Dolt queries, search indexing, migration)
- Structured logging: every log entry should include `{ domain, operation, ...context }`
- No `console.log` anywhere — all logging through the Logger interface

### 5. Operational observability
- Add health check endpoint that reports all subsystem statuses
- Status reporter should include: uptime, article counts, index staleness, last migration timestamp
- Add `monsthera doctor` CLI command that runs all health checks and reports

### 6. Concurrency safety
- Audit `InMemory*Repository` classes for race conditions in async operations
- Ensure Dolt repositories use transactions for multi-step mutations
- Migration service should handle concurrent runs (lock or detect-and-abort)

### 7. Test hardening
- Add edge case tests: empty strings, very long strings, special characters in titles/slugs
- Add error path tests: repository failures, network errors, malformed v2 data
- Ensure test coverage > 90% for all service classes
- Add integration test for full migration flow (v2 read → map → write → verify)

## Design Rules
- No new features — only hardening of existing ones
- Fixes should be minimal and targeted
- Every fix must have a corresponding test
- Do not change public APIs unless fixing a safety issue

## After completing all tasks
```bash
pnpm test && pnpm typecheck && pnpm lint
git add -A && git commit -m "feat: harden v3 for production readiness (Phase 9)"
git push origin rewrite/v3
```
