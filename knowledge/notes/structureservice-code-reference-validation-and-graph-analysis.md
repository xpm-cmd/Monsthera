---
id: k-c04vr46t
title: StructureService: Code reference validation and graph analysis
slug: structureservice-code-reference-validation-and-graph-analysis
category: context
tags: [structure, code-refs, graph, diagnostics, validation]
codeRefs: [src/structure/service.ts, src/context/insights.ts, src/structure/wikilink.ts]
references: [wiki-surfaces-and-wikilink-semantics]
createdAt: 2026-04-11T02:24:58.243Z
updatedAt: 2026-04-18T07:40:31.330Z
---


# StructureService

The `StructureService` builds a knowledge graph from all knowledge and work articles, validates code references against the filesystem, detects stale refs, and provides neighbor traversal for graph navigation. It is a read-only, on-demand service — the graph is recomputed from scratch on every call (no persistent cache).

## Dependencies

Constructed via `StructureServiceDeps`:

- **knowledgeRepo** (`KnowledgeArticleRepository`) — reads all knowledge articles
- **workRepo** (`WorkArticleRepository`) — reads all work articles
- **repoPath** (`string`) — absolute path to the project root, used to resolve codeRefs to filesystem paths
- **logger** (`Logger`) — scoped to `{ domain: "structure" }`

## The graph model

The graph consists of **nodes** and **edges** with typed kinds.

### Node kinds (`StructureNodeKind`)

| Kind | ID prefix | Represents | Key fields |
|---|---|---|---|
| `knowledge` | `k:<articleId>` | A knowledge article | `articleId`, `slug`, `category`, `preview` (first 240 chars), `tags` |
| `work` | `w:<articleId>` | A work article | `articleId`, `phase`, `template`, `priority`, `preview`, `tags` |
| `code` | `c:<codeRef>` | A referenced source file | `path`, `exists` (boolean — validated against filesystem) |
| `tag` | `tag:<tagName>` | A hub node for highly-shared tags | `label` only |

### Edge kinds (`StructureEdgeKind`)

| Kind | Meaning | Created from |
|---|---|---|
| `code_ref` | Article references a source file | `codeRefs` array on any article |
| `reference` | Article explicitly references another article | `references` array + `[[wikilink]]` extraction from content |
| `dependency` | Work article is blocked by another work article | `dependencies` + `blockedBy` arrays on work articles |
| `shared_tag` | Two articles share a tag | Tag co-occurrence (tiered algorithm, see below) |

### Edge ID format

Edges use deterministic IDs for deduplication:
- `code_ref:<nodeId>->c:<codeRef>`
- `reference:<sourceId>->k:<targetId>` or `->w:<targetId>`
- `dependency:<sourceId>->w:<blockerId>`
- `shared_tag:<nodeA><-><nodeB>` (pairwise) or `shared_tag:<nodeId><->tag:<tag>` (hub)

## Graph construction (getGraph)

The `getGraph()` method builds the entire graph in one pass:

1. **Load all articles** — fetches knowledge and work articles in parallel via `Promise.all`.
2. **Create article nodes** — one `knowledge` or `work` node per article, with preview text and metadata.
3. **Collect tag buckets** — groups node IDs by tag for shared-tag edge computation.
4. **Collect codeRef owners** — maps each unique codeRef to the set of article nodes that reference it.
5. **Resolve explicit references** — for each article, resolves `references` array entries and `[[wikilinks]]` extracted from content. Looks up targets by ID or slug in both knowledge and work maps. Unresolved refs are recorded in `gaps.missingReferences`.
6. **Resolve work dependencies** — for each work article, resolves `dependencies` and `blockedBy` arrays. Unresolved IDs go to `gaps.missingDependencies`.
7. **Validate codeRefs** — checks every unique codeRef against the filesystem using `fs.access()` (via `resolveCodeRef()` which handles relative-to-repo-root resolution). All checks run in parallel. Missing files are flagged in `gaps.missingCodeRefs`.
8. **Create code nodes** — one node per unique codeRef with `exists: true/false`. Creates `code_ref` edges from each owning article to the code node.
9. **Compute shared-tag edges** — uses a three-tier algorithm based on how many articles share each tag:
   - **Tier 1** (2-15 articles): pairwise edges between all articles sharing the tag. Edge tags are merged if two articles already share a different tag.
   - **Tier 2** (16-30 articles): creates a hub `tag` node and connects each article to the hub with `shared_tag` edges. Avoids O(n^2) edge explosion.
   - **Tier 3** (31+ articles): tag is omitted entirely, recorded in `gaps.omittedSharedTags`.

The thresholds are constants: `SHARED_TAG_DIRECT_THRESHOLD = 15`, `SHARED_TAG_HUB_THRESHOLD = 30`.

## Graph output

Returns `StructureGraph` containing:

- **nodes** — flat array of all graph nodes
- **edges** — flat array of all graph edges
- **summary** — counts: `nodeCount`, `edgeCount`, `knowledgeCount`, `workCount`, `codeCount`, `sharedTagEdgeCount`, `hubTagCount`, `missingReferenceCount`, `missingDependencyCount`, `missingCodeRefCount`, `omittedSharedTagCount`
- **gaps** — arrays of specific problems: `missingReferences` (format `articleId:refTarget`), `missingDependencies`, `missingCodeRefs` (file paths that don't exist), `omittedSharedTags`

## Stale code ref detection

Code refs are validated by resolving each path relative to `repoPath` using `resolveCodeRef()` from `src/core/code-refs.ts`, then calling `fs.access()`. If the file doesn't exist, the code node gets `exists: false` and the ref appears in `gaps.missingCodeRefs`. This allows agents to identify articles pointing to deleted or moved files.

## Neighbor traversal (getNeighbors)

`getNeighbors(articleIdOrSlug, options?)` finds all edges connected to a specific article:

1. **Builds the full graph** (calls `getGraph()` internally).
2. **Resolves the target node** using multiple strategies in order:
   - Exact node ID match (e.g. `k:abc123`)
   - Prefixed article ID (`k:` then `w:` prefix)
   - Slug match across all nodes
3. **Collects edges** where the target is source or target, producing `NeighborEdge` objects with `direction` ("outgoing"/"incoming"), neighbor metadata, and edge kind.
4. **Filters** by `edgeKinds` if specified (e.g. only `["reference", "code_ref"]`).
5. **Sorts** by edge kind priority: `reference` (0) > `dependency` (1) > `code_ref` (2) > `shared_tag` (3), then alphabetically by neighbor label.
6. **Truncates** to `limit` (default 20, max 50).

Returns `NeighborResult` with the target node, truncated edge list, and a summary with `totalEdges` and `byKind` counts.

## Graph summary (getGraphSummary)

Convenience method that calls `getGraph()` and returns just the `summary` object plus `gaps`. Used by the `get_graph_summary` MCP tool for a quick health overview without transferring the full node/edge arrays.

## Wikilink extraction

The private `extractWikilinks(content)` method uses regex `/\[\[([^\]]+)\]\]/g` to find all `[[slug-or-id]]` references in article content. These are merged with the explicit `references` array for edge resolution.

## Article insights and diagnostics

Defined in `src/context/insights.ts`, these functions score articles for quality and freshness. They are used by `build_context_pack` to annotate search results.

### inspectKnowledgeArticle(article, opts?)

Produces `KnowledgeContextDiagnostics`:

**Freshness scoring** — based on `updatedAt` age:
- 0-14 days: `fresh`
- 15-45 days: `attention`
- 46+ days: `stale`
- Missing timestamp: `unknown`

If the article has a `sourcePath`, the function also checks whether the source file has been modified more recently than the article (`source-newer` state). This overrides freshness to `stale` with label "source newer".

**Quality scoring** (0-100 scale):
- Content length: up to 35 points (1 point per 18 chars)
- Code refs: up to 20 points (8 per ref)
- Tags: up to 10 points (3 per tag)
- Has sourcePath: 15 points
- Freshness bonus: 20 (fresh), 10 (attention), 5 (unknown), 0 (stale)

Quality labels: `excellent` (85+), `strong` (70+), `good` (55+), `fair` (35+), `weak` (<35).

**Mode recommendation** — determines which `ContextPackMode` values the article suits:
- Always: `general`
- `code`: if has codeRefs OR category is architecture/engineering/solution/runbook
- `research`: if has sourcePath OR content >= 600 chars OR category is context/guide/runbook/solution/research

**Signals** reported: `tagCount`, `codeRefCount`, `contentLength`, `hasSourcePath`, `sourceSyncState`.

### inspectWorkArticle(article)

Produces `WorkContextDiagnostics`:

**Freshness** — same age-based logic as knowledge articles (no sourcePath sync check).

**Quality scoring** (0-100 scale):
- Required sections covered: up to 35 points (proportional to template's `requiredSections`)
- References: up to 15 points (7 per ref)
- Code refs: up to 15 points (7 per ref)
- Has owner (lead or assignee): 10 points
- Has assignee: 10 points
- Has `## Implementation` section: 5 points
- Has reviewers: 10 points

**Mode recommendation**:
- Always: `general`
- `code`: if has codeRefs OR has Implementation section OR template is feature/bugfix/refactor
- `research`: if template is spike OR has references OR phase is planning/enrichment

<!-- codex-related-articles:start -->
## Related Articles

- [[wiki-surfaces-and-wikilink-semantics]]
- [[knowledgeservice-crud-search-sync-and-wiki-integration]]
<!-- codex-related-articles:end -->
