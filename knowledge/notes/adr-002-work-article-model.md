---
id: k-n3gtykv5
title: ADR-002: Work Article Model
slug: adr-002-work-article-model
category: architecture
tags: [work-articles, lifecycle, guards, templates, phase-transitions, adr, architecture]
codeRefs: [src/work/lifecycle.ts, src/work/guards.ts, src/work/templates.ts, src/work/schemas.ts, src/work/repository.ts, src/work/service.ts]
references: []
sourcePath: docs/adrs/002-work-article-model.md
createdAt: 2026-04-10T23:03:46.338Z
updatedAt: 2026-04-11T02:14:41.618Z
---

## Overview

The Work Article Model is Monsthera's structured task-tracking system. Work articles are typed, phased entities that move through a guarded lifecycle from planning to completion. They support multi-agent enrichment, review gating, and dependency tracking.

## Work Article Entity

A `WorkArticle` contains:

- **Identity**: `id` (WorkId), `title`, `template`, `author` (AgentId)
- **Lifecycle**: `phase` (current), `phaseHistory` (all transitions with timestamps)
- **Assignment**: `lead?`, `assignee?`, `enrichmentRoles[]`, `reviewers[]`
- **Metadata**: `priority` (critical/high/medium/low), `tags[]`, `references[]`, `codeRefs[]`
- **Dependencies**: `dependencies[]`, `blockedBy[]` (both WorkId arrays)
- **Content**: freeform markdown with required section headings per template
- **Timestamps**: `createdAt`, `updatedAt`, `completedAt?`

## 5-Phase Lifecycle

```
planning → enrichment → implementation → review → done
    \          \              \             \
     └──────────└──────────────└─────────────└──→ cancelled
```

Phases are strictly forward-only. Any non-terminal phase can transition to `cancelled`. Terminal phases (`done`, `cancelled`) cannot transition to anything.

### Valid Transitions (defined in `VALID_TRANSITIONS`)

| From | To | Guards |
|---|---|---|
| planning | enrichment | `has_objective` + `has_acceptance_criteria` (if template requires it) |
| enrichment | implementation | `min_enrichment_met` (threshold from template config) |
| implementation | review | `implementation_linked` |
| review | done | `all_reviewers_approved` |
| any non-terminal | cancelled | (no guards) |

### Transition Logic (`checkTransition`)

1. Reject if current phase is terminal
2. Reject if transition is structurally invalid
3. Bypass guards for cancellation
4. Evaluate all guards in order; first failure stops the transition
5. Return `ok(targetPhase)` if all pass

## Guard System

Guards are pure functions `(article: WorkArticle) => boolean` that gate transitions. See dedicated article for full details.

- **`has_objective`** -- checks `content.includes("## Objective")`
- **`has_acceptance_criteria`** -- checks `content.includes("## Acceptance Criteria")`
- **`min_enrichment_met`** -- counts enrichment roles with status `contributed` or `skipped`, compared to template's `minEnrichmentCount`
- **`implementation_linked`** -- checks `content.includes("## Implementation")`
- **`all_reviewers_approved`** -- requires `reviewers.length > 0` AND all reviewers have status `approved`

## 4 Templates

Each template configures required sections, default enrichment roles, and minimum enrichment count:

| Template | Required Sections | Default Enrichment Roles | Min Enrichment |
|---|---|---|---|
| **feature** | Objective, Context, Acceptance Criteria, Scope | architecture, testing | 1 |
| **bugfix** | Objective, Steps to Reproduce, Acceptance Criteria | testing | 1 |
| **refactor** | Objective, Motivation, Acceptance Criteria | architecture | 1 |
| **spike** | Objective, Research Questions | (none) | 0 |

- `autoAdvance` is `false` for all templates (manual phase advancement only).
- `generateInitialContent()` creates markdown with `## SectionName` headings from the template's `requiredSections`.
- The `spike` template has no acceptance criteria requirement, so the `has_acceptance_criteria` guard is skipped for planning→enrichment.

## Enrichment Flow

During the enrichment phase, agents contribute to assigned roles:

1. Work is created with `enrichmentRoles` populated from template defaults (each as `EnrichmentAssignment` with status `pending`)
2. Agents call `contributeEnrichment(id, role, "contributed" | "skipped")` to record their input
3. The `min_enrichment_met` guard checks how many roles have been `contributed` or `skipped` vs the template's `minEnrichmentCount`
4. Once the threshold is met, the article can advance to implementation

`EnrichmentAssignment` shape: `{ role, agentId, status: "pending"|"contributed"|"skipped", contributedAt? }`

## Review Flow

During the review phase:

1. Reviewers are assigned via `assignReviewer(id, agentId)` -- creates a `ReviewAssignment` with status `pending`
2. Reviewers call `submitReview(id, agentId, "approved" | "changes-requested")`
3. The `all_reviewers_approved` guard requires at least one reviewer AND all must have `approved` status
4. If any reviewer requests changes, the article cannot advance to done until they re-approve

`ReviewAssignment` shape: `{ agentId, status: "pending"|"approved"|"changes-requested", reviewedAt? }`

## Dependencies and Blockers

Work articles can declare blocking relationships:

- `addDependency(id, blockedById)` -- marks article `id` as blocked by `blockedById`
- `removeDependency(id, blockedById)` -- removes the blocking relationship
- `findBlocked()` -- queries all articles that have non-empty `blockedBy` arrays
- Both operations are forbidden on terminal-phase articles
- Adding/removing dependencies emits orchestration events (`dependency_blocked`, `dependency_resolved`)

## WorkService

The `WorkService` orchestrates all work operations and coordinates side effects:

- **CRUD**: `createWork`, `getWork`, `updateWork`, `deleteWork`, `listWork`
- **Lifecycle**: `advancePhase` -- delegates to repo after guard checks
- **Enrichment**: `contributeEnrichment`
- **Review**: `assignReviewer`, `submitReview`
- **Dependencies**: `addDependency`, `removeDependency`

Side effects on mutations:
- Search index sync via `SearchMutationSync`
- Status reporter stat updates (work article count)
- Orchestration event logging (phase advances, dependency changes)
- Wiki bookkeeper log entries and index rebuilds

## Zod Schemas

Three schemas validate work article data:

- `WorkArticleFrontmatterSchema` -- full frontmatter for persistence (all fields)
- `CreateWorkArticleInputSchema` -- creation input (title, template, priority, author required)
- `UpdateWorkArticleInputSchema` -- partial update (all fields optional)

## Source
- Path: `docs/adrs/002-work-article-model.md`
