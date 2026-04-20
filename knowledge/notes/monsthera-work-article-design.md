---
id: k-g0buqcg5
title: Monsthera: Work Article Design
slug: monsthera-work-article-design
category: design
tags: [work-articles, markdown-serialization, data-model, ingest, structure, monsthera-v3, current-docs]
codeRefs: [src/work/repository.ts, src/work/file-repository.ts, src/work/service.ts, src/work/lifecycle.ts, src/work/templates.ts, src/work/schemas.ts, src/knowledge/markdown.ts, src/ingest/service.ts, src/structure/service.ts, src/work/phase-history.ts]
references: [k-n3gtykv5, work-phase-history-and-skipped-guard-audit-trail]
sourcePath: MonstheraV3/monsthera-ticket-as-article-design.md
createdAt: 2026-04-10T23:03:46.193Z
updatedAt: 2026-04-18T07:40:31.435Z
---

## Overview

Work articles are Monsthera's replacement for traditional tickets. They are first-class markdown files stored in `knowledge/work-articles/<id>.md`, using the same `parseMarkdown`/`serializeMarkdown` infrastructure as knowledge articles. Each work article tracks a unit of work through a phased lifecycle with enrichment roles, reviewers, dependencies, and orchestration events.

## WorkArticle Data Model

Defined in `src/work/repository.ts` as a readonly interface:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `WorkId` (branded string) | Unique identifier, generated via `generateWorkId()` |
| `title` | `string` | Human-readable title |
| `template` | `WorkTemplate` | Template type (determines default enrichment roles and initial content) |
| `phase` | `WorkPhase` | Current lifecycle phase: `planning`, `enrichment`, `implementation`, `review`, `done`, `cancelled` |
| `priority` | `Priority` | Priority level |
| `author` | `AgentId` | The agent that created the article |
| `lead` | `AgentId?` | Optional lead agent |
| `assignee` | `AgentId?` | Optional assigned agent |
| `enrichmentRoles` | `EnrichmentAssignment[]` | Role-based enrichment tracking (see below) |
| `reviewers` | `ReviewAssignment[]` | Review gate assignments (see below) |
| `phaseHistory` | `PhaseHistoryEntry[]` | Ordered log of phase transitions with timestamps |
| `tags` | `string[]` | Free-form tags (also carries `v2:` aliases and `migration-hash:` for migration) |
| `references` | `string[]` | IDs or slugs of related knowledge or work articles |
| `codeRefs` | `string[]` | File paths referenced by this work article |
| `dependencies` | `WorkId[]` | All dependency relationships (superset of blockedBy) |
| `blockedBy` | `WorkId[]` | Active blockers preventing progress |
| `content` | `string` | Markdown body (the article text below frontmatter) |
| `createdAt` | `Timestamp` | Creation timestamp |
| `updatedAt` | `Timestamp` | Last modification timestamp |
| `completedAt` | `Timestamp?` | Set when phase advances to `done` |

### EnrichmentAssignment

Each enrichment role tracks a contribution gate:

```typescript
interface EnrichmentAssignment {
  role: string;           // e.g. "research", "architecture", "testing"
  agentId: AgentId;       // assigned agent
  status: "pending" | "contributed" | "skipped";
  contributedAt?: Timestamp;
}
```

Contributions are only accepted during the `enrichment` phase. Default roles come from the work template configuration in `src/work/templates.ts`.

### ReviewAssignment

```typescript
interface ReviewAssignment {
  agentId: AgentId;
  status: "pending" | "approved" | "changes-requested";
  reviewedAt?: Timestamp;
}
```

Reviews are only accepted during the `review` phase.

### PhaseHistoryEntry

```typescript
interface PhaseHistoryEntry {
  phase: WorkPhase;
  enteredAt: Timestamp;
  exitedAt?: Timestamp;  // set when advancing to next phase
}
```

## Markdown Serialization

Work articles are persisted as markdown files using `serializeMarkdown()` from `src/knowledge/markdown.ts`. The file format is YAML frontmatter delimited by `---`, followed by the markdown body.

### How complex fields are stored in frontmatter

Simple fields (id, title, template, phase, priority, author, tags, references, codeRefs, dependencies, blockedBy, createdAt, updatedAt) are stored as plain YAML scalars or inline arrays.

Complex nested objects are serialized as **JSON strings** in specially-named frontmatter keys:

- `enrichmentRolesJson` — `JSON.stringify({ items: article.enrichmentRoles })`
- `reviewersJson` — `JSON.stringify({ items: article.reviewers })`
- `phaseHistoryJson` — `JSON.stringify({ items: article.phaseHistory })`

When reading, these JSON strings are parsed back via `parseJsonArray<T>()` in `file-repository.ts`, which handles both `T[]` and `{ items: T[] }` wrapper formats gracefully, falling back to defaults on parse failure.

### Migration compatibility

Tags carry `v2:` prefixed aliases from the legacy SQLite system and `migration-hash:` tags for idempotent re-runs. These are extracted via `aliasesFromTags()` and `migrationHashFromTags()` and written as `aliases` and `migrationHash` frontmatter fields when present.

### Example frontmatter

```yaml
---
id: w-abc123
title: Implement search ranking
template: feature
phase: enrichment
priority: high
author: claude-opus
tags: [search, ranking]
references: [k-xyz789]
codeRefs: [src/search/service.ts]
dependencies: [w-dep456]
blockedBy: []
createdAt: 2026-04-10T12:00:00.000Z
updatedAt: 2026-04-10T14:30:00.000Z
enrichmentRolesJson: {"items":[{"role":"research","agentId":"claude-opus","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-10T12:00:00.000Z","exitedAt":"2026-04-10T13:00:00.000Z"},{"phase":"enrichment","enteredAt":"2026-04-10T13:00:00.000Z"}]}
---
```

## WorkService Operations

`WorkService` in `src/work/service.ts` wraps the repository with cross-cutting concerns:

- **createWork** — validates input, creates article, syncs search index, logs to wiki bookkeeper, rebuilds wiki index
- **getWork** — reads by ID
- **updateWork** — validates input, updates non-terminal articles, syncs search
- **deleteWork** — removes article, cleans up search index, cascades removal of blockedBy/dependency references from other articles
- **listWork** — lists all or filters by phase
- **advancePhase** — validates transition via `checkTransition()` from `lifecycle.ts`, updates phaseHistory (closes current entry, opens new one), sets `completedAt` on `done`, logs orchestration event
- **contributeEnrichment** — records enrichment contribution/skip (only during enrichment phase)
- **assignReviewer** — adds a reviewer (idempotent guard against duplicates)
- **submitReview** — records review verdict (only during review phase)
- **addDependency / removeDependency** — manages blockedBy relationships with existence checks, logs orchestration events

### Cross-cutting integration

WorkService integrates with:
- **SearchMutationSync** — indexes/removes work articles in the BM25+semantic search index after every mutation
- **OrchestrationEventRepository** — logs phase_advanced, dependency_blocked, dependency_resolved events
- **WikiBookkeeper** — appends to `knowledge/log.md` and rebuilds `knowledge/index.md` after mutations
- **KnowledgeArticleRepository** (optional ref) — used to include knowledge articles when rebuilding the wiki index

## Relationship Between Work and Knowledge

Work and knowledge articles share infrastructure but serve different purposes:

1. **Shared markdown serialization** — both use `parseMarkdown()`/`serializeMarkdown()` from `src/knowledge/markdown.ts`
2. **Shared codeRefs** — both article types can reference the same source files; the structure graph creates `code_ref` edges linking articles to code nodes
3. **Cross-references** — work articles can reference knowledge articles (and vice versa) via the `references` field; the structure service resolves these as `reference` edges in the graph
4. **Shared tags** — the structure service creates `shared_tag` edges between articles (knowledge or work) that share tags, using a tiered strategy (pairwise for <=15 articles, hub nodes for 16-30, omitted for >30)
5. **Unified wiki index** — the WikiBookkeeper rebuilds `knowledge/index.md` with both knowledge and work articles grouped by category/phase
6. **Unified search** — both article types are indexed in the same BM25+semantic search index via `SearchMutationSync`

## Structure Graph

The `StructureService` in `src/structure/service.ts` builds a derived graph from all knowledge and work articles. Node kinds: `knowledge`, `work`, `code`, `tag`. Edge kinds: `code_ref`, `reference`, `dependency`, `shared_tag`. The graph tracks gaps (missing references, missing dependencies, missing code refs, omitted shared tags) for quality diagnostics.

`getNeighbors()` resolves an article by ID, slug, or node ID, then returns sorted neighbor edges with priority: reference > dependency > code_ref > shared_tag.

## Ingest Service

The `IngestService` in `src/ingest/service.ts` imports external files into the knowledge base (not work articles). It:

1. Accepts a `sourcePath` (file or directory), resolves it relative to the repo root
2. Scans directories recursively (skipping `.git`, `node_modules`, `dist`, `.monsthera`, `knowledge/`)
3. Supports `.md`, `.markdown`, `.txt`, `.text` extensions
4. Operates in two modes: `raw` (full content) or `summary` (extracts summary paragraph, key points, headings)
5. Extracts title from frontmatter, first heading, or humanized filename
6. Infers category from the top-level directory name
7. Auto-extracts code refs from content via regex pattern matching, verified against filesystem
8. Deduplicates by `sourcePath` — if `replaceExisting` is true, updates existing articles instead of creating duplicates
9. Syncs each imported article to the search index

Summary mode produces structured content with sections: Source, Summary, Key points, Important headings, Code references, Import note.

<!-- codex-related-articles:start -->
## Related Articles

- [[adr-002-work-article-model]]
- [[work-article-guard-system]]
- [[work-phase-history-and-skipped-guard-audit-trail]]
<!-- codex-related-articles:end -->
