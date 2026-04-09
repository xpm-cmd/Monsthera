# MonstheraV3 Docs

This folder contains the canonical design docs for the Monsthera v3 clean rewrite.

Monsthera v3 is not an in-place refactor of v2. It is a new implementation guided by the final architecture, with migration and compatibility handled at the edges.

## Canonical documents

Read these in this order:

1. `monsthera-architecture-v6-final.md`
   Product and system design for the v3 target architecture.

2. `monsthera-ticket-as-article-design.md`
   Domain-model design for replacing tickets with work articles.

3. `monsthera-v3-implementation-plan-final.md`
   Execution plan for delivering the rewrite.

## Current repo reality

The repository is already on the v3 rewrite path:

- `src/` contains the new domain-oriented skeleton
- `docs/adrs/` contains accepted architecture decisions
- `docs/CODING-STANDARDS.md` defines the rewrite rules
- `README.md` at the repo root describes the current alpha rewrite status

These documents in `MonstheraV3/` are the higher-level narrative that ties those pieces together.

## Relationship to ADRs

The ADRs are implementation-grade decisions.

These docs are broader:

- architecture doc: destination
- work article doc: key domain shift
- implementation plan: how the rewrite is executed

When there is tension between them:

- ADRs win on already-accepted low-level decisions
- the architecture doc wins on end-state shape
- the implementation plan wins on sequencing and delivery strategy

## Rewrite assumptions

The canonical assumptions for v3 are:

- clean rewrite
- work articles replace tickets in the v3 core
- council/verdict/quorum are v2 concepts and do not belong in the v3 core
- Markdown is the human-facing layer
- Dolt is the structured, versioned backend target
- Claude plus the Codex plugin is a first-class implementation workflow and should influence task design, module boundaries, and documentation quality

## Recommended use

Use this folder when:

- aligning on v3 architecture
- planning implementation waves
- onboarding Claude/Codex-driven implementation work
- checking whether a design decision fits the rewrite boundary

Do not use this folder as a substitute for:

- the live source tree
- accepted ADRs
- tests
- the repo root README for current operational status

