---
id: k-ofsgt3dd
title: Work Article Template System
slug: work-article-template-system
category: context
tags: [work-articles, templates, enrichment-roles, configuration]
codeRefs: [src/work/templates.ts, src/work/lifecycle.ts, src/work/guards.ts]
references: [k-n3gtykv5]
createdAt: 2026-04-11T02:15:28.735Z
updatedAt: 2026-04-11T02:15:28.735Z
---

## Overview

The template system configures how work articles behave based on their type. There are 4 templates (`feature`, `bugfix`, `refactor`, `spike`), each defining required content sections, default enrichment roles, and the minimum enrichment threshold needed to advance past the enrichment phase.

## WorkTemplateConfig Interface

```typescript
interface WorkTemplateConfig {
  readonly template: WorkTemplateType;           // "feature" | "bugfix" | "refactor" | "spike"
  readonly requiredSections: readonly string[];  // Section headings required in content
  readonly defaultEnrichmentRoles: readonly EnrichmentRoleType[];  // Roles assigned on creation
  readonly minEnrichmentCount: number;           // Min contributions to advance past enrichment
  readonly autoAdvance: boolean;                 // Currently false for all templates
}
```

## Template Details

### Feature (`WorkTemplate.FEATURE`)
- **Required Sections**: Objective, Context, Acceptance Criteria, Scope
- **Default Enrichment Roles**: `architecture`, `testing`
- **Min Enrichment Count**: 1
- **Use case**: New capabilities or significant additions to the system.
- **Guard behavior**: Both `has_objective` and `has_acceptance_criteria` are checked at planning -> enrichment. Two enrichment roles are assigned by default (architecture review + testing strategy), but only 1 must be completed to advance.

### Bugfix (`WorkTemplate.BUGFIX`)
- **Required Sections**: Objective, Steps to Reproduce, Acceptance Criteria
- **Default Enrichment Roles**: `testing`
- **Min Enrichment Count**: 1
- **Use case**: Fixing known defects with reproducible steps.
- **Guard behavior**: "Steps to Reproduce" is a required section but not a guard -- it's enforced by convention. Testing enrichment ensures a test plan exists before implementation.

### Refactor (`WorkTemplate.REFACTOR`)
- **Required Sections**: Objective, Motivation, Acceptance Criteria
- **Default Enrichment Roles**: `architecture`
- **Min Enrichment Count**: 1
- **Use case**: Structural improvements without behavior change.
- **Guard behavior**: Architecture enrichment ensures the refactoring approach is reviewed before implementation begins.

### Spike (`WorkTemplate.SPIKE`)
- **Required Sections**: Objective, Research Questions
- **Default Enrichment Roles**: (none)
- **Min Enrichment Count**: 0
- **Use case**: Time-boxed investigation or research tasks.
- **Guard behavior**: No acceptance criteria guard (uses "Research Questions" instead). No enrichment roles required -- spikes can advance directly from enrichment to implementation with zero contributions. This reflects that spikes are lightweight exploratory work.

## How Templates Affect the Lifecycle

### At Creation
- `generateInitialContent(template)` produces markdown with `## SectionName` headings for each required section, giving agents a skeleton to fill in.
- `enrichmentRoles` on the new `WorkArticle` is populated from `defaultEnrichmentRoles`.

### At planning -> enrichment
- The `getGuardSet()` function checks if the template's `requiredSections` includes "Acceptance Criteria". If yes, the `has_acceptance_criteria` guard is added. If not (spike), it's skipped.

### At enrichment -> implementation
- The `min_enrichment_met` guard uses the template's `minEnrichmentCount` as its threshold. For spike (threshold=0), this guard effectively auto-passes.

### autoAdvance Flag
- Currently `false` for all 4 templates. This means phase transitions are always explicit via `advancePhase()`. The flag exists as infrastructure for future templates that might auto-advance when guards pass.

## Enrichment Roles

The `EnrichmentRole` enum provides the vocabulary for enrichment assignments:
- `architecture` -- reviews structural/design implications
- `testing` -- defines test strategy and acceptance test plan

Templates assign a subset of these as defaults. Additional roles can be added manually. Each role becomes an `EnrichmentAssignment` on the work article with initial status `pending`.

## Helper Functions

- `getTemplateConfig(template)` -- returns the `WorkTemplateConfig` for a given template type
- `generateInitialContent(template)` -- produces skeleton markdown content with section headings
