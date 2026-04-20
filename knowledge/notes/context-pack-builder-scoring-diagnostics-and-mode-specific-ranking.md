---
id: k-x8umv6et
title: Context Pack Builder: Scoring, Diagnostics, and Mode-Specific Ranking
slug: context-pack-builder-scoring-diagnostics-and-mode-specific-ranking
category: context
tags: [context-pack, scoring, diagnostics, freshness, quality, search, code-refs]
codeRefs: [src/search/service.ts, src/context/insights.ts, src/core/code-refs.ts, src/work/templates.ts, src/tools/search-tools.ts, src/tools/snapshot-tools.ts]
references: [k-ypsx5ask]
createdAt: 2026-04-11T02:16:43.540Z
updatedAt: 2026-04-20T00:00:00.000Z
---

## How build_context_pack Works

`buildContextPack()` in `SearchService` (`src/search/service.ts`) is Monsthera's primary agent-facing tool. It returns a ranked, annotated set of articles with quality diagnostics, freshness checks, stale code ref detection, and mode-specific guidance.

## Pipeline

1. **Candidate retrieval:** Runs `search()` with `limit * 3` (minimum 12) candidates to create a deep pool
2. **Article hydration:** For each search hit, fetches the full article from the knowledge or work repository. Stale index entries (article deleted but still in index) are silently skipped and counted in `skippedStaleIndexCount`
3. **Diagnostics computation:** Runs `inspectKnowledgeArticle()` or `inspectWorkArticle()` (`src/context/insights.ts`) to assess freshness and quality
4. **Code ref validation:** Each code ref is resolved against the filesystem via `resolveCodeRef()`. Refs pointing to missing files are separated into `staleCodeRefs`
5. **Composite scoring:** `scoreContextPackItem()` combines search score with quality, freshness, and mode-specific bonuses
6. **Sort and slice:** Items sorted by composite score, sliced to the requested limit (max 20)
7. **Summary and guidance:** Aggregated statistics and mode-specific guidance strings are attached

## Quality Scoring (inspectKnowledgeArticle)

Quality score is 0-100, computed from (`src/context/insights.ts`):

- **Content length:** `min(35, contentLength / 18)` — up to 35 points for ~630+ chars
- **Code refs:** `min(20, codeRefCount * 8)` — up to 20 points for 3+ code refs
- **Tags:** `min(10, tagCount * 3)` — up to 10 points for 4+ tags
- **Source path:** 15 points if the article has a linked source file
- **Freshness bonus:** fresh=20, attention=10, unknown=5, stale=0

Labels: >=85 "excellent", >=70 "strong", >=55 "good", >=35 "fair", <35 "weak"

## Quality Scoring (inspectWorkArticle)

Work article quality is scored differently:

- **Required sections coverage:** `(covered / total) * 35` — checks for `## SectionName` headers matching the template's required sections
- **References:** `min(15, refCount * 7)` — up to 15 points
- **Code refs:** `min(15, codeRefCount * 7)` — up to 15 points
- **Owner:** 10 points if lead or assignee is set
- **Assignee:** 10 additional points
- **Implementation section:** 5 points if present
- **Reviewers:** 10 points if any reviewers assigned

## Freshness Assessment

Freshness is time-based (`src/context/insights.ts`):

- **fresh:** updated within 14 days
- **attention:** updated 15-45 days ago
- **stale:** updated 45+ days ago
- **unknown:** no valid updatedAt timestamp

For knowledge articles with a `sourcePath`, the system also checks source sync: if the linked file's mtime is newer than the article's updatedAt by more than 60 seconds, freshness is overridden to "stale" with label "source newer".

## Composite Score Formula

`scoreContextPackItem()` builds the final ranking score:

```
total = searchScore
      + qualityScore / 40          # quality contributes up to ~2.5 points
      + freshnessBonus             # fresh=+0.5, attention=+0.2, unknown=+0.1, stale=-0.25
      + modeBonus                  # varies by mode
```

### Mode: code
- Code refs: `min(1.2, codeRefCount * 0.35)` bonus
- Knowledge category in [architecture, engineering, solution, runbook]: +0.4
- Work template in [feature, bugfix, refactor]: +0.35
- Work phase is implementation or review: +0.2

### Mode: research
- References: `min(0.8, referenceCount * 0.2)` bonus
- Has source path: +0.5
- Knowledge category in [guide, context, solution, runbook, research]: +0.4
- Work template is spike: +0.8
- Work phase is planning or enrichment: +0.2

### Mode: general
No additional bonuses — uses base score + quality + freshness only.

## Context Pack Output

The returned `ContextPack` includes:

- **summary:** counts of items, knowledge vs work, fresh vs stale, code-linked vs source-linked, skipped stale index entries
- **guidance:** array of mode-specific actionable strings (e.g. "Start with the highest-ranked code-linked items to minimize blind repository scanning")
- **items:** each with `id`, `title`, `type`, `score`, `searchScore`, `reason` (human-readable quality summary), `snippet`, `updatedAt`, `codeRefs`, `staleCodeRefs`, and full `diagnostics` (freshness + quality)

## Reason String

Each item gets a human-readable `reason` built from signals: quality label, code ref count, reference count, source path presence, legacy status, and freshness state. Example: "strong quality · 3 code ref(s) · linked source path · fresh context"

## exclude_ids Filter

The `build_context_pack` tool accepts an optional `exclude_ids: string[]` parameter (`src/tools/search-tools.ts`). Any article IDs listed here are dropped from the ranked candidate set before the top-N slice is computed, freeing a slot for the next-best item. The validation path rejects non-array or non-string-array values with a `VALIDATION_FAILED` response.

The intended use is when the caller already has an article in hand — most commonly the `work_id` they're currently operating on. To avoid breaking existing callers, `exclude_ids` is **never** auto-populated from `work_id`; callers must opt in explicitly by passing `[work_id]` (or any other IDs they want suppressed).

## Snapshot-Aware Context

When `agent_id` or `work_id` is provided, the tool handler in `src/tools/search-tools.ts` also resolves the most recent environment snapshot via `SnapshotService.getLatest()` (wired through `SearchToolDeps.snapshotService`). The behaviour:

- `work_id` is preferred when both are set; the service falls back to the agent's latest snapshot if none was recorded against the work.
- When a snapshot is found, the response includes a `snapshot` field alongside `items`, carrying `id`, `agentId`, `workId`, `capturedAt`, `ageSeconds`, `stale`, `cwd`, `gitRef`, `runtimes`, `packageManagers`, `lockfiles`, and `files` — i.e. the physical sandbox state matched to the semantic pack.
- If the snapshot is older than the configured max age (`MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES`, default 30), the `stale` flag is set and an extra guidance string is appended: `"stale_snapshot: the attached environment snapshot is older than the configured max age; re-capture before trusting cwd, lockfile, or runtime fields."`
- A missing snapshot never fails the pack — service errors and unwired `snapshotService` both resolve to `null` and the `snapshot` field is simply omitted from the response.

This lets an agent receive semantic context (what the project means) and physical context (what this sandbox actually is) in a single call, and be warned when the two may be out of sync. See `src/tools/snapshot-tools.ts` for the companion `record_environment_snapshot`, `get_latest_environment_snapshot`, and `compare_environment_snapshots` tools that feed and query this state.