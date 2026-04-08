# Monsthera v3 — Full Codebase Audit Report

**Date:** 2026-04-08
**Auditor:** Claude Opus 4.6
**Branch:** `rewrite/v3` (via `claude/stoic-meitner` worktree)
**Test suite:** 821 tests, 39 test files — all passing
**TypeScript:** Clean (zero type errors)

---

## Architecture Compliance Score: 89/100

| Category | Score | Weight | Weighted |
|---|---|---|---|
| Domain completeness | 95/100 | 25% | 23.75 |
| ADR compliance | 95/100 | 20% | 19.00 |
| Code quality | 85/100 | 20% | 17.00 |
| Test coverage | 78/100 | 20% | 15.60 |
| Security/Performance | 90/100 | 15% | 13.50 |
| **Total** | | | **88.85 ≈ 89** |

---

## Executive Summary

### What's Solid

- **Domain model is correct and complete.** All 7 domains from the architecture are implemented: core, knowledge, work, search, persistence, orchestration, migration.
- **Work article lifecycle matches ADR-002 exactly.** Five phases (planning → enrichment → implementation → review → done) plus cancelled. Guards are pure boolean functions. Enrichment replaces council voting. Review is inline.
- **Repository pattern is clean.** Interfaces in domain directories, in-memory implementations for tests, Dolt implementations in `src/persistence/`. No leaky abstractions.
- **Migration boundary (ADR-003) is fully respected.** Zero v2 type imports in v3 core. All migration code is isolated in `src/migration/`.
- **Transport layers (ADR-005) are thin.** MCP tools, CLI, and dashboard all delegate to services. One minor violation in dashboard.
- **Result types used consistently** for all fallible operations across all domains.
- **Branded types** (ArticleId, WorkId, Slug, etc.) used throughout.
- **Zero TODO/FIXME/HACK** comments in production code.
- **Zero default exports.** All `.js` extensions present in imports. ESM-only.

### What Needs Work

Two files exceed the 500-line hard cap. The orchestration barrel export is incomplete. Persistence layer has zero test coverage. A few minor ADR-005 and coding standard violations.

---

## Issues — Severity-Ranked

### CRITICAL (0 issues)

No critical issues found.

### HIGH (2 issues)

#### H-1: `src/cli/main.ts` exceeds 500-line hard cap (644 lines)

**File:** `src/cli/main.ts:1`
**Standard:** CODING-STANDARDS.md — "300-line soft cap, 500-line hard cap. Files over 500 lines must be split."

The CLI entry point contains all subcommand handlers in a single file: knowledge CRUD (5 commands), work CRUD + lifecycle (11 commands), search, reindex, serve, and status. This makes the file hard to navigate and violates the hard cap.

**Fix:** Extract command handlers into separate files:
- `src/cli/knowledge-commands.ts` — knowledge subcommand handlers
- `src/cli/work-commands.ts` — work subcommand handlers
- `src/cli/search-commands.ts` — search/reindex handlers
- `src/cli/main.ts` — argument parsing and dispatch only

#### H-2: `src/persistence/dolt-work-repository.ts` exceeds 500-line hard cap (601 lines)

**File:** `src/persistence/dolt-work-repository.ts:1`
**Standard:** CODING-STANDARDS.md — same rule.

The Dolt work article repository contains all CRUD, query, phase transition, enrichment, review, and dependency methods in one file.

**Fix:** Extract query methods and helper logic:
- `src/persistence/dolt-work-queries.ts` — findByPhase, findByAssignee, findByPriority, findActive, findBlocked
- `src/persistence/dolt-work-repository.ts` — CRUD + phase transitions (core mutations)

---

### MEDIUM (6 issues)

#### M-1: Orchestration barrel export is incomplete

**File:** `src/orchestration/index.ts:1-2`
**Issue:** Only re-exports `repository.ts`. Missing: `service.ts`, `types.ts`, `in-memory-repository.ts`.

Consumers that need the orchestration service or types must import directly from internal files rather than the barrel, breaking the "barrel files export only the public API" pattern from CODING-STANDARDS.md.

**Fix:** Add missing re-exports to `src/orchestration/index.ts`.

#### M-2: `VALID_PHASES` constant duplicated

**File:** `src/dashboard/index.ts:9` and `src/tools/work-tools.ts:9`
**Issue:** Both files independently construct `new Set(Object.values(WorkPhase))`. If `WorkPhase` enum changes, both must be updated.

**Fix:** Export a `VALID_PHASES` set from `src/core/types.ts` and import it in both files.

#### M-3: Dashboard contains domain validation logic (ADR-005 violation)

**File:** `src/dashboard/index.ts:149-151`
**Issue:** The `/api/work` route handler validates the phase parameter against `VALID_PHASES` directly instead of delegating to the service layer. Per ADR-005, transport layers should only validate input format, not business rules.

**Fix:** Pass the raw `phaseParam` to `WorkService.listWork()` and let the service validate it, or use a shared validation function from `src/work/schemas.ts`.

#### M-4: Persistence layer has zero unit tests

**File:** `src/persistence/*.ts` (9 files, 1,863 lines)
**Issue:** The Dolt repository implementations (`DoltKnowledgeArticleRepository`, `DoltWorkRepository`, `DoltSearchIndexRepository`, `DoltOrchestrationRepository`), connection pool, schema initialization, and health checks have no test files. This is noted in ADR-001 as acceptable ("Tests bootstrap with the in-memory adapter only. Dolt integration tests run in CI against a containerized Dolt instance"), but no CI integration tests exist yet.

**Impact:** SQL generation bugs, connection leaks, or schema drift would not be caught until production.

**Fix:** Add integration test stubs in `tests/integration/persistence/` that document what needs CI Dolt coverage. Consider adding a mock-based test for the query builder logic in `dolt-work-repository.ts`.

#### M-5: N+3 query pattern in DoltWorkRepository

**File:** `src/persistence/dolt-work-repository.ts:97-136` (and lines 295-394)
**Issue:** `findMany()`, `findByPhase()`, `findByAssignee()`, `findByPriority()`, `findActive()`, and `findBlocked()` all fetch a list of article IDs, then make 3 additional queries per article (enrichments, reviews, phase history). For 100 articles, this means 301 queries.

**Impact:** Poor performance at scale. Acceptable for early development but will need optimization before production use.

**Fix:** Batch the related-data queries using `WHERE work_id IN (?, ?, ...)` after collecting all IDs, then assemble in memory. Or use JOINs with post-processing.

#### M-6: MCP server registration (`src/server.ts`) has no tests

**File:** `src/server.ts` (119 lines)
**Issue:** The MCP server bootstrap — tool registration, request handling, transport setup — is untested. Protocol-level errors would not be caught.

**Fix:** Add `tests/unit/server.test.ts` testing tool registration count, handler delegation, and error response format.

---

### LOW (5 issues)

#### L-1: Unsafe `as WorkPhase` cast in CLI

**File:** `src/cli/main.ts:441`
**Issue:** User input is cast to `WorkPhase` without validation: `phase as WorkPhase`. If the user provides an invalid phase string, it would bypass type safety.

**Fix:** Validate against `WorkPhase` values before casting, similar to how `work-tools.ts` uses `requireEnum()`.

#### L-2: Single `any` usage in container

**File:** `src/core/container.ts:68`
**Issue:** `let doltPool: any` with eslint-disable comment. The Dolt pool type is not narrowed.

**Fix:** Type as `Pool | undefined` from `mysql2/promise` or use a generic wrapper type.

#### L-3: `src/cli/index.ts` is effectively empty

**File:** `src/cli/index.ts:1`
**Issue:** Contains only `// CLI commands` — no exports. Not a functioning barrel.

**Fix:** Either add proper re-exports or remove the file.

#### L-4: Knowledge `serializeMarkdown()` lacks error handling

**File:** `src/knowledge/markdown.ts:123`
**Issue:** Returns `string` directly instead of `Result<string, ValidationError>`. If frontmatter contains values that can't be serialized (unlikely but possible), the function would throw.

**Fix:** Low risk — the function only processes already-validated data. Document the precondition or wrap in Result for consistency.

#### L-5: Search tokenizer doesn't handle Unicode

**File:** `src/search/tokenizer.ts:47`
**Issue:** Regex `/[^a-z0-9]+/` strips all non-ASCII characters. CJK text, accented characters, and emoji would be tokenized as empty strings and dropped.

**Fix:** Use `/[^\p{L}\p{N}]+/u` for Unicode-aware tokenization, or document the ASCII-only limitation.

---

## Audit Checklist

### Architecture Consistency

| Item | Status | Notes |
|---|---|---|
| All 7 domains implemented | PASS | core, knowledge, work, search, persistence, orchestration, migration |
| Work article lifecycle (5 phases) | PASS | planning → enrichment → implementation → review → done + cancelled |
| Guards are pure and deterministic | PASS | All 5 guards in `src/work/guards.ts` — no I/O, no side effects |
| Repository interfaces abstracted | PASS | Interfaces in domain dirs, impls in persistence/ and in-memory |
| Dolt backend follows ADR-001 | PASS | Markdown + Dolt dual-write, atomic commits, file locking described |
| MCP/CLI/Dashboard are thin | PASS (minor) | One M-3 violation in dashboard phase validation |
| Migration follows ADR-003 | PASS | Zero v2 imports in v3 core; migration isolated in `src/migration/` |

### Code Quality

| Item | Status | Notes |
|---|---|---|
| Files follow CODING-STANDARDS.md | FAIL (2) | H-1 and H-2: two files exceed 500-line hard cap |
| Consistent error handling (Result types) | PASS | All fallible ops return Result; no thrown exceptions for expected failures |
| Branded types used | PASS | ArticleId, WorkId, AgentId, SessionId, Slug, Timestamp |
| No circular dependencies | PASS | Clean dependency graph: core ← domains ← persistence/tools/cli |
| JSDoc on public APIs | PARTIAL | 182 JSDoc comments across source; some service methods lack docs |
| No TODO/FIXME/HACK in production | PASS | Zero found |
| ESM-only, .js extensions | PASS | All local imports include `.js` |
| No default exports | PASS | Zero default exports |
| No console.log in production | PASS | Only in `src/cli/main.ts` and `src/bin.ts` (acceptable) |
| Zod v4 imports | PASS | All schemas import from `zod/v4` |

### Test Coverage

| Domain | Has Tests | Test Count | Gaps |
|---|---|---|---|
| core | YES | 72 | Minor edge cases |
| knowledge | YES | 110 | Bulk ops, concurrency |
| work | YES | 193 | Rollback, concurrent reviews |
| search | YES | 52 | Real embeddings, Unicode |
| orchestration | YES | 35 | Race conditions |
| migration | YES | 23 | Large-scale, partial failure |
| tools | YES | 173 | Status tools thin (4 tests) |
| persistence | NO | 0 | **ALL Dolt repos untested** (M-4) |
| server | NO | 0 | **MCP registration untested** (M-6) |
| dashboard | YES | 13 | Write operations |
| cli | YES | 21 | Invalid args, signals |
| hardening | YES | 44 | Edge cases, concurrency |
| integration | YES | 23 | Bootstrap, CRUD flows |

### Security/Performance

| Item | Status | Notes |
|---|---|---|
| SQL injection protection | PASS | All Dolt queries use parameterized `?` placeholders |
| Input validation on public APIs | PASS | Zod schemas validate all MCP/CLI/dashboard inputs |
| No hardcoded secrets | PASS | Config loaded from file/env; no secrets in source |
| Proper async/await | PASS | Consistent async patterns; no floating promises |
| Resource cleanup | PASS | Connection pools, intervals, disposable stack all properly cleaned |
| N+3 query pattern | WARN | M-5: Performance concern in DoltWorkRepository at scale |

---

## Recommended Fix Priority

1. **H-1 + H-2:** Split the two over-limit files (required by coding standards)
2. **M-1:** Fix orchestration barrel export (5-minute fix)
3. **M-2:** Extract shared `VALID_PHASES` constant (5-minute fix)
4. **M-3:** Move dashboard phase validation to service layer
5. **L-1:** Add phase validation in CLI before cast
6. **M-4 + M-6:** Add test stubs for persistence and server (longer-term)
7. **M-5:** Optimize N+3 queries (performance, can defer)
