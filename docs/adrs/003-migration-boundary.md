# ADR-003: Migration Boundary

**Status:** Accepted  
**Date:** 2026-04-07  
**Decision makers:** Architecture team

## Context

Monsthera v3 is a clean rewrite. The temptation in clean rewrites is to import legacy types "just to ease migration" — this invariably pulls legacy architecture debt into the new core and makes the rewrite boundary porous. v2 has SQLite as its database, with tickets, council assignments, verdicts, and work groups as first-class entities. v3 replaces all of these with a different model.

Migration tooling must exist, but it must not corrupt the new core.

## Decision

v2 migration is a Phase 8 edge concern. The v3 core — all code under `src/domain/`, `src/app/`, and `src/infra/` — never imports v2 types, schemas, or database handles. Migration lives entirely in `src/migration/` and is invoked as a standalone CLI command.

- Migration tooling reads from the v2 SQLite database using its own read-only connection.
- Migration tooling writes v3 Markdown files and Dolt rows using the v3 repository interfaces.
- The ticket → work article mapping is the responsibility of `src/migration/mappers/ticket.mapper.ts`.
- Council assignments and verdicts are mapped to enrichment sections in the resulting work article Markdown body.
- Original v2 ticket IDs are preserved as an `aliases` array in the v3 article frontmatter for cross-reference.
- Dry-run mode is required: `monsthera migrate --dry-run` prints what would be written without touching disk or Dolt.
- Migration is repeatable and idempotent: running it twice produces the same output. Articles already present in v3 (matched by alias) are skipped unless `--force` is passed.

## Consequences

### Positive
- v3 core remains free of legacy architecture debt — no sqlite3 dependency, no v2 type imports, no conditional code paths for backwards compatibility.
- Migration being isolated in `src/migration/` makes it easy to delete once all teams have migrated.
- Idempotency means migration can be run incrementally (e.g., migrate completed tickets first, active tickets after a cutover window).
- Dry-run mode allows teams to validate output before committing.

### Negative
- Migration tooling is a meaningful engineering investment; it cannot be skipped if there is live v2 data.
- The mapper must handle v2 data quality issues (null fields, malformed states) defensively, adding complexity.
- Two SQLite and Dolt connections must be managed during migration runs — operational complexity for teams running the tool.

### Neutral
- The `src/migration/` subtree is not covered by the v3 core test suite. It has its own test fixtures using a sample v2 SQLite snapshot.
- Once migration is complete, `src/migration/` can be removed from the repository entirely without affecting the core.

## Implementation Notes

- Entry point: `src/migration/cli.ts`. Commands: `migrate tickets`, `migrate knowledge`, `migrate all`.
- v2 SQLite access: `src/migration/v2/db.ts` — opens a read-only sqlite3 connection. No Drizzle, no ORM. Raw SQL only.
- Mapper convention: `src/migration/mappers/<entity>.mapper.ts`, each exports a `map(v2Entity): WorkArticle` function.
- Verdict → enrichment mapping: each verdict becomes a `## Verdict: <councilMemberName>` section with the verdict text and outcome. The `approved` / `rejected` status is preserved in a metadata comment at the section top.
- ID aliasing: `aliases: ["T-1234"]` in frontmatter. The v3 `find_by_alias` repository method resolves these for cross-reference links from external tools.
- Idempotency key: SHA-256 of the v2 ticket ID string stored in frontmatter as `migration_hash`. The migration runner skips any article whose `migration_hash` already matches.
- Dry-run output format: YAML diff of what would be written, one document per would-be article. No files created, no Dolt writes.
