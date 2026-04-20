---
id: k-cg3xlfgt
title: Trust Signal System: Legacy Content Identification and Search Demotion
slug: trust-signal-system-legacy-content-identification-and-search-demotion
category: context
tags: [trust-signals, search, legacy, migration, scoring, reranking]
codeRefs: [src/core/article-trust.ts, src/search/service.ts, src/cli/doctor-commands.ts]
references: [k-rksv8m51]
createdAt: 2026-04-11T02:15:20.086Z
updatedAt: 2026-04-11T02:15:20.086Z
---

## Purpose

The trust signal system ensures that migrated v2 content does not crowd out native v3 content in search results. It identifies legacy articles by their metadata and applies score penalties during search reranking, so agents naturally see fresh, authoritative content first.

## Legacy Detection (`article-trust.ts`)

Three tag prefixes mark an article as legacy:
- `v2-source:` — knowledge articles migrated from the v2 SQLite `knowledge` or `notes` tables
- `v2:` — work articles carrying a v2 ticket ID alias (e.g., `v2:T-1234`)
- `migration-hash:` — any article created by the migration pipeline (contains its idempotency hash)

`hasLegacyTag(tags)` checks if any tag starts with one of these prefixes. Two higher-level functions wrap it:
- `isLegacyKnowledgeArticle(article)` — checks tags only
- `isLegacyWorkArticle(article)` — checks tags OR `author === "migration"`

The `isLegacyQuery(query)` function uses a regex (`/\b(?:agora|legacy|v2|tkt-[a-z0-9]+)\b/i`) to detect when the user is intentionally searching for legacy content. When true, demotion penalties are bypassed.

## Search Demotion (`search/service.ts` — `rerankForTrust()`)

After hybrid BM25+semantic search produces scored results, `rerankForTrust()` adjusts scores:

### Penalties (demote legacy)
| Article type | Penalty |
|---|---|
| Legacy knowledge article | -1.2 |
| Legacy work article | -1.1 |

### Bonuses (promote quality)
| Signal | Bonus |
|---|---|
| Knowledge article has `sourcePath` (imported from docs) | +0.45 |
| Knowledge category is architecture/decision/guide/runbook | +0.15 |
| Work article in active phase (planning/implementation/review) | +0.2 |

### Legacy query bypass
If `isLegacyQuery(query)` is true, the entire reranking step is skipped — legacy content keeps its original search score. This prevents the system from hiding the very content the user is asking for.

### Score floor
After reranking, articles with score <= 0 are filtered out (unless all results would be removed, in which case they are all kept). This means heavily penalized legacy content effectively disappears from results when better alternatives exist.

## Usage in the Codebase

- **Search service** — primary consumer; calls `rerankForTrust()` on every search
- **Doctor commands** (`cli/doctor-commands.ts`) — uses `isLegacyKnowledgeArticle` and `isLegacyWorkArticle` to count and audit legacy articles
- **Context packs** — search results feed into `build_context_pack`, so trust demotion propagates to agent context automatically

## Design Rationale

The system avoids hard deletion of legacy content. Instead, it uses soft demotion so that:
1. Legacy content remains accessible when explicitly queried
2. Native v3 content naturally surfaces first for general queries
3. The penalty values (-1.2, -1.1) are tuned so legacy content still appears when there are no better alternatives
4. The `v2:` alias tags allow backward-compatible linking even after demotion