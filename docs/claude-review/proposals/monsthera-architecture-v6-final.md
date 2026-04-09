# Monsthera: Hybrid Knowledge Architecture v6

## Final architecture for the v3 clean rewrite

**Status:** Canonical design document  
**Last reviewed:** 2026-04-07  
**Implementation model:** clean rewrite  
**Primary execution model:** Claude orchestrating implementation through the Codex plugin

---

## 1. Purpose

Monsthera v3 is a knowledge-native development platform for AI coding agents.

It replaces the v2 model of:

- ticket-centric workflow
- council/verdict governance
- SQLite-coupled internals
- cross-cutting handler logic

with a system centered on:

- Markdown-native knowledge
- work articles as the canonical work model
- deterministic phase guards
- repository-based persistence
- versioned structured storage
- thin transport surfaces for MCP, CLI, and dashboard

This document describes the target system shape.

It does not describe the detailed sequencing of the rewrite. That lives in `monsthera-v3-implementation-plan-final.md`.

---

## 2. Design decisions

| Area | Decision |
|---|---|
| Human-facing content | Markdown files are the primary human-readable layer |
| Structured storage | Dolt is the target backend for versioned structured state |
| Work model | Work articles replace tickets |
| Governance | Enrichment + review replace council/quorum/verdict workflows |
| State model | Explicit phase state machine with pure guards |
| Automation | Guard-driven orchestration with conservative defaults |
| Architecture style | Clean domain boundaries with repository interfaces |
| Surface boundaries | MCP, CLI, and dashboard are thin transport layers |
| Migration | v2 migration is an edge concern, not a core concern |
| Implementation workflow | Claude + Codex plugin is assumed and influences design quality rules |

---

## 3. System thesis

Monsthera should make project knowledge accumulate automatically as work happens.

The system should support these three truths at once:

1. Humans need readable artifacts.
2. Agents need structured, queryable state.
3. Teams need a work model that preserves reasoning, not just status transitions.

That leads to the core v3 thesis:

- knowledge is written as articles
- work is captured as articles
- structure is derived, indexed, and versioned
- orchestration follows explicit guards rather than ad hoc process

---

## 4. High-level architecture

```text
Human
  |
  v
knowledge/ (Markdown articles)
  |
  v
Monsthera v3 core
  |- knowledge domain
  |- work domain
  |- search domain
  |- ingest domain
  |- structure domain
  |- orchestration domain
  |- agent coordination domain
  |
  v
Repository interfaces
  |
  v
Dolt-backed structured storage
  |
  v
MCP / CLI / Dashboard surfaces
```

The important point is that Markdown and structured storage are complementary, not competing:

- Markdown is the human-facing artifact layer
- Dolt is the structured query and versioning layer

---

## 5. Core domains

### 5.1 Knowledge

The knowledge domain manages:

- concepts
- decisions
- patterns
- guides
- source summaries
- synthesis notes
- sessions
- work-derived permanent knowledge

Knowledge artifacts are Markdown-native and queryable through structured metadata.

### 5.2 Work

The work domain is the heart of v3.

A work article is:

- a plan
- an enrichment surface
- an implementation record
- a review record
- a permanent historical artifact

This replaces the v2 split between tickets, comments, verdicts, and review state.

### 5.3 Search

The search domain spans:

- lexical search
- semantic search
- code-to-knowledge links
- work retrieval
- scoped and boosted retrieval based on context

Search should serve both humans and agents, and it should work across knowledge and work.

### 5.4 Ingest

The ingest domain brings external material into the knowledge system:

- manual notes
- structured imports
- source summaries
- future web-search and raw-source ingestion

### 5.5 Structure

The structure domain derives order from the knowledge graph:

- categorization
- glossary generation
- code map generation
- relationship extraction
- gap detection

### 5.6 Orchestration

The orchestration domain advances work conservatively using:

- phase guards
- explicit transitions
- wave planning
- agent spawning
- structured event logging

### 5.7 Agents and coordination

Agent coordination remains a first-class concern, but it is now aligned to the work/article model instead of the ticket model.

---

## 6. Work articles

Work articles are the canonical work unit in v3.

They replace:

- tickets
- ticket comments
- council assignments
- verdict records
- part of the old review flow

### 6.1 Lifecycle

The lifecycle is:

```text
planning -> enrichment -> implementation -> review -> done
                                  \
                                   -> cancelled
```

### 6.2 Why this model exists

The v2 model optimized for workflow bookkeeping.

The v3 model optimizes for:

- shared understanding
- permanent implementation context
- specialist contributions inside the artifact
- deterministic automation

### 6.3 Work article sections

A work article typically includes:

- objective
- context
- acceptance criteria
- scope
- open questions
- enrichment sections
- implementation section
- review sections
- completion summary

### 6.4 Frontmatter

Typical structured fields include:

- `id`
- `title`
- `phase`
- `template`
- `assignee`
- `lead`
- `enrichment_roles`
- `reviewers`
- `aliases`
- `created_at`
- `updated_at`

---

## 7. Enrichment and review

v3 removes the council/quorum model from the core.

It replaces it with:

- enrichment contributions by roles
- inline review sections
- deterministic guard checks
- explicit lead or service-driven advancement

### 7.1 Enrichment

Enrichment is the phase where specialists add perspective before implementation is considered ready.

Typical roles:

- architecture
- security
- performance
- testing
- developer experience

### 7.2 Review

Review is also embedded in the work artifact.

Reviewers contribute structured assessments and outcomes such as:

- `approved`
- `changes-requested`

No separate verdict subsystem is required in the v3 core.

---

## 8. Knowledge model

The knowledge system is Markdown-first.

### 8.1 Why Markdown

Markdown is:

- human-readable
- portable
- diffable
- tool-agnostic
- compatible with agent workflows

### 8.2 Derived views

Monsthera should compile derived artifacts such as:

- `_index.md`
- `_glossary.md`
- `log.md`
- future `_map.md`

These are derived artifacts, not hand-maintained source material.

### 8.3 Schema and conventions

`_schema.md` defines living conventions for the article space and can evolve with the system.

---

## 9. Persistence model

### 9.1 Boundary

Persistence is hidden behind repository interfaces.

The core domains do not know whether data comes from:

- Dolt
- an in-memory adapter
- a future alternate backend

### 9.2 Target backend

Dolt is the target production backend because the architecture requires:

- versioned structured state
- branch/merge/diff semantics
- durable historical trace

### 9.3 Test backend

In-memory adapters are valid for:

- unit tests
- integration tests that do not require Dolt semantics

### 9.4 Migration boundary

The migration layer can talk to v2 SQLite.

The v3 core cannot.

---

## 10. Orchestration model

The orchestration model is guard-driven.

### 10.1 Guards

Guards are:

- pure
- deterministic
- testable

They answer questions such as:

- does this article have acceptance criteria?
- is enrichment sufficient?
- are all reviewers approved?

### 10.2 Orchestrator

The orchestrator:

- scans active work
- evaluates next-phase guards
- emits events
- optionally spawns agents
- advances work only when rules allow it

### 10.3 Automation philosophy

Automation should be conservative by default.

The system should prefer:

- explicit readiness events
- opt-in auto-advance
- observable behavior
- operator override

---

## 11. Surface boundaries

v3 strictly separates domain logic from transport.

### 11.1 MCP

MCP tools are thin adapters:

- validate input
- call services
- return JSON

### 11.2 CLI

CLI commands are thin adapters:

- parse args
- validate input
- call services
- format output

### 11.3 Dashboard

The dashboard is a client of the domain services.

It does not own separate business logic.

### 11.4 Rule

No domain rules should live only in:

- a tool handler
- a CLI command
- a dashboard route

---

## 12. Claude + Codex implementation assumptions

This architecture assumes that implementation work will be driven primarily by Claude using the Codex plugin.

That has architectural consequences.

### 12.1 The codebase must be agent-friendly

That means:

- small, focused modules
- explicit contracts
- JSON-first operational outputs
- deterministic commands
- clear ownership boundaries
- minimal hidden state

### 12.2 Task design is part of architecture quality

If tasks are too wide or too implicit, the rewrite will degrade.

The architecture therefore prefers:

- isolated subsystems
- ADR-backed boundaries
- narrow services
- schema-first work
- testable guards and repositories

### 12.3 Anti-debt rule

The rewrite should never create new debt by becoming:

- oversized
- magical
- convention-heavy without docs
- transport-centric

---

## 13. Recommended repository shape

The target structure is approximately:

```text
src/
|- core/
|- knowledge/
|- work/
|- search/
|- ingest/
|- structure/
|- orchestration/
|- agents/
|- patches/
|- dashboard/
|- cli/
`- tools/
```

Expected supporting directories:

```text
docs/
|- adrs/
`- operational guides

templates/
schemas/
tests/
knowledge/
```

The key point is conceptual, not cosmetic:

- the repo should reflect the v3 domains directly
- the old ticket-centric organization should not leak back in

---

## 14. Migration stance

Migration matters, but it is not part of the v3 core model.

The migration layer should:

- read v2 data
- map tickets to work articles
- map verdicts to enrichment/review content
- preserve IDs as aliases
- validate imported output

The migration layer should not force:

- v2 table shapes
- council concepts
- SQLite assumptions

into the v3 runtime.

---

## 15. Definition of architectural success

The architecture is successful if v3 ends up:

- cleaner than v2
- easier for agents to extend
- more readable for humans
- more explicit in its workflow model
- less coupled across storage, transport, and orchestration
- capable of importing v2 history without inheriting v2 architecture debt

