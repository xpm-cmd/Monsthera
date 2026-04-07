# ADR-001: Storage Model

**Status:** Accepted  
**Date:** 2026-04-07  
**Decision makers:** Architecture team

## Context

v2 used SQLite + Drizzle ORM as the sole persistence layer. Domain entities were tightly coupled to table schemas, migration files proliferated, and querying was spread throughout the codebase with no abstraction boundary. There was no concept of versioned state — rollback meant restoring backups, and diffs were impossible without external tooling.

v3 requires versioned data with git-like semantics: branch, merge, diff, and rollback on structured project data. Human-facing content (work articles, notes, plans) needs to be readable outside the application. A single flat database cannot satisfy both concerns well.

## Decision

Markdown files are the source of truth for all human-facing content. A Dolt versioned SQL database serves as the structured query index. SQLite is not used in v3.

- All work articles, knowledge entries, and human-readable artifacts live as Markdown files in the `knowledge/` directory tree.
- Dolt provides SQL query capability over structured metadata (phases, assignees, tags, links), with full git-like versioning semantics.
- Every phase transition is an atomic Dolt commit with a semantic message (e.g., `feat(work): advance WA-042 planning → enrichment`).
- The Repository pattern abstracts all persistence. Callers depend on interfaces; storage backends are injected.
- An in-memory adapter satisfies the repository interface for unit and integration tests — no Dolt instance required.
- The Dolt adapter is the production implementation and is the only place Dolt SQL is written.
- File claims with heartbeat prevent concurrent write conflicts: a writer atomically creates a `.lock` sidecar, refreshes it on an interval, and removes it on release.

## Consequences

### Positive
- Markdown files are portable, diffable, and human-readable without tooling.
- Dolt gives true version history, branching, and merge on structured data — enabling time-travel queries and safe experimentation.
- Repository abstraction makes domain logic testable without a running database.
- Phase transitions become auditable commit history rather than implicit state mutations.

### Negative
- Dolt is an operational dependency — teams must run and maintain a Dolt server.
- Keeping Markdown and Dolt in sync requires discipline; a crash between the two writes leaves the system inconsistent without compensating logic.
- The in-memory adapter must faithfully replicate Dolt query semantics — divergence will hide bugs until production.

### Neutral
- Drizzle ORM and all SQLite migration files are deleted. Teams familiar with v2 will need to learn the new repository interfaces.
- File-locking via heartbeat adds operational complexity that SQLite row locking handled transparently.

## Implementation Notes

- Repository interfaces live in `src/domain/ports/`. Two implementations: `src/infra/memory/` and `src/infra/dolt/`.
- The `knowledge/` directory mirrors the Dolt schema: `knowledge/work-articles/`, `knowledge/notes/`, etc.
- Dolt commit is called inside a unit-of-work wrapper that also fsync-flushes the Markdown write, so the two stores advance together.
- Lock files are named `<article-id>.lock` and contain `{ owner, pid, expires }` JSON. The heartbeat interval is 5 seconds; locks expire after 30 seconds of no refresh.
- Tests bootstrap with the in-memory adapter only. Dolt integration tests run in CI against a containerized Dolt instance.
