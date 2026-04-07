# ADR-002: Work Article Model

**Status:** Accepted  
**Date:** 2026-04-07  
**Decision makers:** Architecture team

## Context

v2 represented work as tickets with 10+ discrete states (open, triaged, council-assigned, council-voting, verdict-pending, approved, rejected, in-progress, review-pending, review-failed, done, archived). Governance was council-based: a quorum of council members cast verdicts that unlocked forward progress. This produced complex, hard-to-reason-about state machines and made it difficult to understand a ticket's full history at a glance.

v3 targets a simpler mental model: a work item is a living document that accumulates content as it moves through its lifecycle, with specialists contributing analysis sections instead of casting votes.

## Decision

Work articles replace tickets. The lifecycle has exactly 5 phases — `planning`, `enrichment`, `implementation`, `review`, `done` — and guards are pure boolean functions that determine whether a transition is permitted.

- A work article is a single Markdown file. The file is the entire record of the item across its lifetime.
- YAML frontmatter carries structured metadata: `id`, `phase`, `template`, `assignee`, `enrichment_roles`, `reviewers`, and `created_at` / `updated_at`.
- Each phase appends a named content section to the Markdown body. Earlier sections are never overwritten.
- Guards are pure functions with the signature `(article: WorkArticle) => boolean`. They evaluate the article's current state only — no side effects, no I/O.
- Standard guards: `has_objective`, `has_acceptance_criteria`, `min_enrichment_met`, `implementation_linked`, `all_reviewers_approved`.
- Enrichment replaces council voting. Specialists write perspective sections (e.g., `## Security Perspective`, `## Architecture Perspective`). The lead decides when enrichment is sufficient by evaluating `min_enrichment_met`.
- Review is inline: reviewers add a `## Review: <name>` section with their assessment and a verdict line (`approved` / `changes-requested`). `all_reviewers_approved` checks all listed reviewer sections.
- Four templates ship by default: `feature`, `bugfix`, `refactor`, `spike`. Templates define required sections and the default enrichment role list.
- No council entities, verdict tables, or quorum concepts exist in v3.

## Consequences

### Positive
- A single Markdown file contains the complete history of a work item — readable by anyone without tooling.
- Pure guard functions are trivially testable and auditable; there is no hidden state machine logic.
- Enrichment model scales from solo developer (no enrichment roles) to large team (multiple specialists) by configuration.
- Removing council/quorum eliminates the most complex governance code in v2.

### Negative
- Five phases may feel too coarse for teams that relied on fine-grained v2 states (e.g., separate triaged vs. council-assigned states).
- Storing the entire lifecycle in one file means large, long-running articles accumulate significant content — navigation requires tooling or conventions.
- Frontmatter schema changes require a migration across all article files.

### Neutral
- Enrichment roles are advisory, not enforced by a voting mechanism. Teams must establish process norms around what counts as sufficient enrichment.
- The `done` phase is terminal. Archiving is handled by moving the file, not by changing the phase field.

## Implementation Notes

- Work article type: `src/domain/models/work-article.ts`. Frontmatter parsed with `gray-matter` or equivalent.
- Guard functions: `src/domain/guards/`. Each guard is a named export; guard sets per transition are declared in `src/domain/lifecycle.ts`.
- Template definitions: `src/domain/templates/`. Each template exports required sections, default enrichment roles, and auto-advance configuration.
- Phase transition service: `src/domain/services/phase-transition.service.ts`. Validates guards, appends the new section heading, updates frontmatter, persists via repository.
- The `enrichment_roles` frontmatter field is an array of role identifiers. `min_enrichment_met` checks that at least N roles from that list have contributed a section, where N is configurable per template.
- Reviewer identities in `reviewers` frontmatter must match section headings for `all_reviewers_approved` to resolve correctly.
