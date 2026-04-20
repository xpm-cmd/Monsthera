---
id: k-qhu1sw8h
title: MCP Tool Catalog — Complete Reference
slug: mcp-tool-catalog-complete-reference
category: guide
tags: [mcp, tools, reference]
codeRefs: [src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/tools/search-tools.ts, src/tools/orchestration-tools.ts, src/tools/status-tools.ts, src/tools/ingest-tools.ts, src/tools/structure-tools.ts, src/tools/validation.ts, src/server.ts, src/tools/agent-tools.ts, src/tools/wave-tools.ts, src/tools/wiki-tools.ts]
references: [k-8dsb3up8, agent-and-wave-mcp-tools, wiki-surfaces-and-wikilink-semantics]
createdAt: 2026-04-11T02:17:34.606Z
updatedAt: 2026-04-18T07:40:31.259Z
---

## Overview

Monsthera exposes **28 MCP tools** via stdio transport, organized into 7 groups. All tools return JSON responses through the standard MCP `CallToolResult` format. Input validation is handled by `src/tools/validation.ts` before delegation to services.

---

## Knowledge Tools (6 tools)

Source: `src/tools/knowledge-tools.ts`

### `create_article`
Create a reusable knowledge article. Search index syncs automatically.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| title | string | yes | Article title |
| category | string | yes | Category (e.g. decision, guide, pattern, context, solution, gotcha) |
| content | string | yes | Markdown content |
| tags | string[] | no | Tags for discovery |
| codeRefs | string[] | no | File paths referenced by article |
| references | string[] | no | IDs or slugs of related articles |

### `get_article`
Retrieve a knowledge article by ID or slug. Includes graph connections (references, shared tags, code links) when available.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | no | Article ID (e.g. k-abc123) |
| slug | string | no | Article slug (e.g. architecture-overview) |
At least one of `id` or `slug` is required.

### `update_article`
Update an existing knowledge article. Only provided fields are changed. Search syncs automatically.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Article ID |
| title | string | no | New title |
| category | string | no | New category |
| content | string | no | New content |
| tags | string[] | no | Replacement tags |
| codeRefs | string[] | no | Replacement code refs |
| references | string[] | no | Replacement references |

### `delete_article`
Delete a knowledge article. Search index syncs automatically.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Article ID |

### `list_articles`
List knowledge articles with optional category filter. Returns summaries (id, title, slug, category, tags, updatedAt) without content. Paginated.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| category | string | no | Filter by category |
| limit | number | no | Max results 1-100, default 20 |
| offset | number | no | Skip N results, default 0 |

### `search_articles`
Search knowledge articles only (not work). Returns summaries with 200-char content snippet.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | yes | Search query (max 1000 chars) |
| limit | number | no | Max results 1-50, default 10 |
| offset | number | no | Skip N results, default 0 |

---

## Work Tools (11 tools)

Source: `src/tools/work-tools.ts`

### `create_work`
Create a work article (handoff contract for execution). Starts in `planning` phase.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| title | string | yes | Work article title |
| template | enum | yes | `feature`, `bugfix`, `refactor`, `spike` |
| priority | enum | yes | `critical`, `high`, `medium`, `low` |
| author | string | yes | Author agent ID |
| lead | string | no | Lead agent ID |
| tags | string[] | no | Tags |
| content | string | no | Initial markdown content |

### `get_work`
Retrieve a work article by ID. Includes graph connections.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article ID |

### `update_work`
Update a work article. Only provided fields change.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article ID |
| title | string | no | New title |
| priority | enum | no | `critical`, `high`, `medium`, `low` |
| lead | string | no | Lead agent ID |
| assignee | string | no | Assignee agent ID |
| tags | string[] | no | Replacement tags |
| references | string[] | no | Replacement references |
| codeRefs | string[] | no | Replacement code refs |
| content | string | no | New content |

### `delete_work`
Delete a work article.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article ID |

### `list_work`
List work articles with optional phase filter. Returns summaries. Paginated.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| phase | enum | no | `planning`, `enrichment`, `implementation`, `review`, `done`, `cancelled` |
| limit | number | no | Max results 1-100, default 20 |
| offset | number | no | Skip N results, default 0 |

### `advance_phase`
Advance a work article to the next lifecycle phase. Guards must pass.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article ID |
| targetPhase | enum | yes | `planning`, `enrichment`, `implementation`, `review`, `done`, `cancelled` |

### `contribute_enrichment`
Record an enrichment contribution or explicit skip for a specialist role.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article ID |
| role | string | yes | Enrichment role (e.g. architecture, security, testing) |
| status | enum | yes | `contributed` or `skipped` |

### `assign_reviewer`
Assign a reviewer to a work article, making review an explicit gate.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article ID |
| agentId | string | yes | Reviewer agent ID |

### `submit_review`
Submit a review outcome to close or reopen the review gate.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article ID |
| agentId | string | yes | Reviewer agent ID |
| status | enum | yes | `approved` or `changes-requested` |

### `add_dependency`
Add a blocking dependency between two work articles.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article being blocked |
| blockedById | string | yes | Work article that is the blocker |

### `remove_dependency`
Remove a blocking dependency.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Work article ID |
| blockedById | string | yes | Blocker work article ID to remove |

---

## Search Tools (5 tools)

Source: `src/tools/search-tools.ts`

### `search`
Hybrid BM25 keyword search across knowledge and work articles. Short queries (1-3 terms) use AND semantics; longer queries use OR with BM25 ranking.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | yes | Search query |
| type | enum | no | `knowledge`, `work`, `all` (default all) |
| limit | number | no | Max results 1-100, default 20 |
| offset | number | no | Skip N results, default 0 |

### `build_context_pack`
Recommended first step before coding or investigation. Assembles a ranked context pack with freshness, quality, and code-link signals.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| query | string | yes | Search query for pack assembly |
| mode | enum | no | `general`, `code`, `research` |
| type | enum | no | `knowledge`, `work`, `all` |
| limit | number | no | Max items 1-20, default 8 |
| verbose | boolean | no | Include full diagnostics (default false) |

### `index_article`
Manually index or re-index a specific article. For repair/backfill only; normal CRUD auto-syncs.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Article ID |
| source | enum | yes | `knowledge` or `work` |

### `remove_from_index`
Remove an article from the search index. For repair flows only.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| id | string | yes | Article ID |

### `reindex_all`
Rebuild the entire search index from all knowledge and work articles. Also triggers wiki index.md rebuild. Use after migrations, bulk imports, or recovery.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| (none) | | | |

---

## Orchestration Tools (2 tools)

Source: `src/tools/orchestration-tools.ts`

### `log_event`
Log an orchestration event for audit and coordination.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workId | string | yes | Work article ID |
| eventType | enum | yes | `phase_advanced`, `agent_spawned`, `agent_completed`, `dependency_blocked`, `dependency_resolved`, `guard_evaluated`, `error_occurred` |
| details | object | yes | Event details (arbitrary JSON object) |
| agentId | string | no | Agent ID |

### `get_events`
Retrieve orchestration events, optionally filtered.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| workId | string | no | Filter by work article ID |
| eventType | string | no | Filter by event type |
| limit | number | no | Max events, default 50 |

---

## Status Tools (1 tool)

Source: `src/tools/status-tools.ts`

### `status`
Returns system status, health, and subsystem info. No parameters.

---

## Ingest Tools (1 tool)

Source: `src/tools/ingest-tools.ts`

### `ingest_local_sources`
Import a local markdown/text file or directory into knowledge articles.
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| sourcePath | string | yes | Relative or absolute path to file or directory |
| category | string | no | Category override for imported articles |
| tags | string[] | no | Extra tags to append |
| codeRefs | string[] | no | Extra code refs to append |
| mode | enum | no | `raw` (preserve content) or `summary` (normalized article) |
| recursive | boolean | no | Recurse into subdirectories (default true) |
| replaceExisting | boolean | no | Update previously imported articles with same sourcePath (default true) |

---

## Structure / Graph Tools (2 tools)

Source: `src/tools/structure-tools.ts`

### `get_neighbors`
Navigate the knowledge graph from any article. Returns direct connections (references, dependencies, shared tags, code links).
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| article | string | yes | Article ID, slug, or node ID |
| edge_kinds | string[] | no | Filter: `reference`, `dependency`, `code_ref`, `shared_tag` |
| limit | number | no | Max neighbors 1-50, default 20 |

### `get_graph_summary`
High-level overview of the knowledge graph: node/edge counts by type and structural gaps. No parameters.

<!-- codex-related-articles:start -->
## Related Articles

- [[agent-and-wave-mcp-tools]]
- [[wiki-surfaces-and-wikilink-semantics]]
- [[adr-005-surface-boundaries]]
<!-- codex-related-articles:end -->
