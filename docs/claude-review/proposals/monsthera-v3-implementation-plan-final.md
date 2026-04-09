# Monsthera v3: Implementation Plan

## Clean rewrite plan

**Status:** Canonical execution plan  
**Last reviewed:** 2026-04-07  
**Design source:** `monsthera-architecture-v6-final.md`

---

## 1. Strategy

Monsthera v3 is a clean rewrite.

That means:

- v2 is the old product line
- v3 is a new implementation
- migration exists, but at the edges
- the new core is not shaped by the old ticket/council/SQLite architecture

---

## 2. Rewrite priorities

Build in this order:

1. foundation
2. knowledge articles
3. work articles
4. search and retrieval
5. persistence backend
6. transport surfaces
7. orchestration
8. migration
9. hardening

---

## 3. Claude + Codex execution model

The rewrite is expected to be implemented mainly by Claude using the Codex plugin.

That implies:

- tasks should be narrow and explicit
- module boundaries should be crisp
- contracts should be written before broad implementation
- every subsystem should have clear acceptance criteria
- commands and tool outputs should be JSON-first

Recommended rhythm:

1. write ADR or subsystem note
2. define schemas and interfaces
3. implement domain logic
4. wire adapters
5. add tests
6. document the result

---

## 4. Phases

### Phase 0: Bootstrap

- establish rewrite branch workflow
- define ADR set
- define coding and task standards

### Phase 1: Foundation

- config
- container/composition root
- repository interfaces
- core errors, result types, status, logging
- server bootstrap

### Phase 2: Knowledge system

- article schemas
- parser/writer
- derived views
- knowledge repositories and services

### Phase 3: Work article system

- work article schema
- templates
- phase state machine
- guards
- enrichment and review model

### Phase 4: Search and retrieval

- lexical search
- semantic abstraction
- code-to-knowledge links
- work retrieval

### Phase 5: Persistence

- production backend adapter
- versioned storage semantics
- health checks and repo wiring

### Phase 6: Surfaces

- MCP tools
- CLI commands
- dashboard views and routes

### Phase 7: Orchestration

- guard evaluation services
- orchestration loop
- wave planning
- event log

### Phase 8: Migration

- v2 import tooling
- dry-run
- validation reports
- alias preservation

### Phase 9: Hardening

- performance
- concurrency
- docs
- release prep

---

## 5. Definition of done

v3 is done when:

- the core is article/work based
- tickets are no longer part of the core runtime model
- guards and orchestration are deterministic
- transport layers are thin
- migration from v2 is repeatable
- Claude + Codex can continue extending the codebase without fighting hidden coupling

