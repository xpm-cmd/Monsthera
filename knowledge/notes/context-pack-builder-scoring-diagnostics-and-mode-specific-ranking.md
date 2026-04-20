---
id: k-x8umv6et
title: Context Pack Builder: Scoring, Diagnostics, and Mode-Specific Ranking
slug: context-pack-builder-scoring-diagnostics-and-mode-specific-ranking
category: context
tags: [context-pack, scoring, diagnostics, freshness, quality, search, code-refs]
codeRefs: [src/search/service.ts, src/context/insights.ts, src/core/code-refs.ts, src/work/templates.ts]
references: [k-ypsx5ask]
createdAt: 2026-04-11T02:16:43.540Z
updatedAt: 2026-04-11T02:16:43.540Z
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