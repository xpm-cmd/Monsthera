---
id: k-rksv8m51
title: ADR-003: Migration Boundary
slug: adr-003-migration-boundary
category: architecture
tags: [migration, v2-compat, sqlite, idempotency, trust-signals, adr]
codeRefs: [src/migration/service.ts, src/migration/v2-reader.ts, src/migration/mapper.ts, src/migration/types.ts, src/migration/tools.ts, src/core/article-trust.ts, src/search/service.ts, src/work/file-repository.ts]
references: []
sourcePath: docs/adrs/003-migration-boundary.md
createdAt: 2026-04-10T23:03:46.434Z
updatedAt: 2026-04-11T02:14:54.989Z
---

## Source
- Path: `docs/adrs/003-migration-boundary.md`

## Overview

ADR-003 defines the migration boundary: a one-way pipeline that reads from a v2 SQLite database and writes v3 markdown articles (knowledge + work). The boundary is strictly isolated — v3 core code never imports v2 types.

## Architecture

### Read side: SqliteV2SourceReader (`v2-reader.ts`)

Opens the v2 SQLite database in **read-only** mode via `node:sqlite`. Auto-detects two schema dialects:
- **"current"** — has `review_verdicts` table (newer v2 schema with `tickets.ticket_id`, `severity`, `priority` columns)
- **"legacy"** — original schema with `tickets.id`, `status`, `priority` string columns

Reads five entity types:
1. **Tickets** — `readTickets()` → `V2Ticket[]`
2. **Verdicts** — `readVerdicts(ticketId)` → `V2Verdict[]` (council review outcomes)
3. **Assignments** — `readAssignments(ticketId)` → `V2CouncilAssignment[]`
4. **Knowledge** — `readKnowledge()` → `V2KnowledgeRecord[]` (from `knowledge` table)
5. **Notes** — `readNotes()` → `V2NoteRecord[]` (from `notes` table, with metadata/linked_paths parsed)

### Mapping layer (`mapper.ts`)

Pure functions with no I/O that transform v2 records to v3 shapes:

- `mapTicketToArticle(ticket, verdicts, assignments)` → `MappedArticle` (work)
  - Infers template from tags/title heuristics (bug/bugfix→bugfix, refactor→refactor, spike/research→spike, default→feature)
  - Maps priority: p0→critical, p1→high, p2→medium, p3→low
  - Maps status to phase: open→planning, in-progress→implementation, resolved/closed→done, wontfix→cancelled
  - Builds markdown content with acceptance criteria, council assignments, and verdict sections
- `mapKnowledgeToArticle(record)` → `MappedKnowledgeArticle`
- `mapNoteToArticle(record)` → `MappedKnowledgeArticle` (derives title from first content line)

### Write side: MigrationService (`service.ts`)

Writes to v3 via `KnowledgeArticleRepository` and `WorkArticleRepository` (markdown file repos).

## Three Migration Modes

| Mode | Behavior |
|------|----------|
| `dry-run` | Reads v2, maps records, reports what *would* be created. No writes. |
| `validate` | Same as dry-run but also runs validation checks (empty title, missing template/priority, no aliases). |
| `execute` | Full migration: reads, maps, validates, writes v3 articles. Records `lastMigrationAt` in runtime state. |

All three modes return a `MigrationReport` with counts of created/skipped/failed items.

## Scope

The `scope` option controls what gets migrated:
- `"work"` — only tickets → work articles
- `"knowledge"` — only knowledge rows + notes → knowledge articles
- `"all"` (default) — both

## Idempotency via migration-hash Tags

Each migrated record gets a deterministic hash computed from its v2 ID:
```
migration-hash:<sha256(v2Id)>           # for work articles
migration-hash:<sha256("knowledge:" + key)>  # for knowledge
migration-hash:<sha256("note:" + key)>       # for notes
```

Before writing, `MigrationService` scans existing v3 articles for a matching `migration-hash:` tag. If found, the item is **skipped** (status: "skipped", reason: "Migration hash already exists in v3"). The `force` option bypasses this check for re-migration.

## v2: Alias Tags for Old ID Preservation

Work articles receive `v2:<ticketId>` tags (e.g., `v2:T-1234`). These serve two purposes:
1. **Alias resolution** — `resolveAlias("T-1234")` returns the v3 work article ID via the in-memory `AliasStore`
2. **State hydration** — on service startup, `hydrateMigrationState()` scans all work articles for `v2:` tags and rebuilds the alias map

Knowledge articles receive `v2-source:<kind>:<key>` tags (e.g., `v2-source:knowledge:auth-flow`).

As noted in `file-repository.ts` (lines 48-57): these tags are **transitional metadata** stored in the tags array rather than as explicit schema fields, designed to age out when v2 references are no longer active.

## Trust Signal Integration

Migrated articles are identified as "legacy" by `article-trust.ts` using three signals:
- Tags starting with `v2-source:`, `v2:`, or `migration-hash:` → `hasLegacyTag()` returns true
- Work articles with `author === "migration"` → `isLegacyWorkArticle()` returns true
- Queries containing "agora", "legacy", "v2", or "tkt-*" patterns → `isLegacyQuery()` returns true

The search service (`search/service.ts`) applies trust-adjusted scoring in `rerankForTrust()`:
- Legacy knowledge articles receive a **-1.2 score penalty**
- Legacy work articles receive a **-1.1 score penalty**
- If the query itself is legacy-related (`isLegacyQuery`), penalties are **skipped** (legacy content is intentionally relevant)
- Articles with positive trust signals (sourcePath, active phase, high-value category) receive small bonuses

This ensures migrated content naturally sinks below native v3 content in search results unless the user is explicitly looking for legacy material.

## MCP Tools (`tools.ts`)

Three tools exposed to agents:
1. **`migrate_v2`** — runs migration with mode (required), force, and scope options
2. **`migration_status`** — returns alias count and migrated article counts
3. **`resolve_v2_alias`** — maps a v2 ticket ID to its v3 work article ID