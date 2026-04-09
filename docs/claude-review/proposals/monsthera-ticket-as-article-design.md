# Monsthera: Work Article Design

## Tickets become work articles in v3

**Status:** Canonical domain design  
**Last reviewed:** 2026-04-07

---

## 1. Why this change exists

In v2, work was represented by several separate artifacts:

- ticket record
- ticket history
- ticket comments
- council assignments
- verdict records

That model made workflow state explicit, but it fragmented meaning across tables and views.

In v3, the work unit becomes a single evolving artifact: the work article.

---

## 2. Core idea

A work article is a Markdown document that accumulates the full lifecycle of a work item:

- planning
- enrichment
- implementation
- review
- completion

It is both:

- the live work artifact
- the historical record of why the work happened and how it was done

---

## 3. What it replaces

| v2 concept | v3 replacement |
|---|---|
| ticket | work article |
| ticket status machine | phase field plus deterministic guards |
| ticket comments | timeline or inline sections |
| council assignments | enrichment roles |
| verdicts | review and enrichment sections |
| quorum | explicit guard evaluation and configured review requirements |

---

## 4. Lifecycle

The lifecycle is:

```text
planning -> enrichment -> implementation -> review -> done
                                  \
                                   -> cancelled
```

This is intentionally smaller and clearer than the v2 ticket lifecycle.

---

## 5. Article structure

### 5.1 Frontmatter

Example fields:

```yaml
id: WA-0042
title: Implement hybrid knowledge query planner
phase: planning
template: feature
lead: agent-architect
assignee: null
enrichment_roles:
  - architecture
  - security
  - testing
reviewers:
  - agent-reviewer-1
aliases:
  - TKT-184
created_at: 2026-04-07T10:00:00Z
updated_at: 2026-04-07T10:00:00Z
```

### 5.2 Body sections

Typical sections:

- Objective
- Context
- Acceptance Criteria
- Scope
- Open Questions
- Enrichment sections
- Implementation
- Review sections
- Completion Summary

---

## 6. Enrichment model

Enrichment is where specialists add perspective before implementation is finalized.

Possible sections:

- Architecture Perspective
- Security Perspective
- Performance Perspective
- Testing Perspective

The lead or service logic uses guard evaluation to determine whether enrichment is sufficient.

There is no council vote in the v3 core.

---

## 7. Review model

Review happens inside the work article.

Reviewer sections can include:

- reviewer identity
- summary
- outcome
- requested follow-ups

Outcomes should be normalized to simple values like:

- `approved`
- `changes-requested`

This keeps the model explicit and easy to query.

---

## 8. Why this is better

The work article model improves on tickets because:

- the entire lifecycle is readable in one place
- work becomes permanent documentation automatically
- specialist knowledge is preserved inside the artifact
- automation can rely on explicit guards instead of scattered workflow logic
- migration to knowledge is natural because the artifact is already documentation-shaped

---

## 9. Design rules

The v3 core should follow these rules:

- work articles are the canonical work model
- tickets do not exist in the core
- verdict/quorum/council do not exist in the core
- comments are not a separate required subsystem
- review and enrichment content belong in the article

Migration adapters may understand old concepts, but the v3 runtime should not require them.

