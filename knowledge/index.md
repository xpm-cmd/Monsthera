# Monsthera Index

> Auto-generated catalog of 44 knowledge articles and 0 work articles.
> Last updated: 2026-04-18 07:48:45

## Knowledge

### architecture

- [ADR-001: Storage Model](notes/adr-001-storage-model.md) — ## Dual Storage Model  Monsthera uses a **dual storage architecture**: Markdown
- [ADR-002: Work Article Model](notes/adr-002-work-article-model.md) — ## Overview  The Work Article Model is Monsthera's structured task-tracking syst
- [ADR-003: Migration Boundary](notes/adr-003-migration-boundary.md) — ## Source - Path: `docs/adrs/003-migration-boundary.md`  ## Overview  ADR-003 de
- [ADR-004: Orchestration Model](notes/adr-004-orchestration-model.md) — ## ADR-004: Orchestration Model  Status: Accepted | Date: 2026-04-07  ### What s
- [ADR-005: Surface Boundaries](notes/adr-005-surface-boundaries.md) — ## Status Accepted — 2026-04-07  ## Decision Monsthera exposes three distinct su
- [Monsthera: Hybrid Knowledge Architecture v6](notes/monsthera-hybrid-knowledge-architecture-v6.md) — ## Overview  Monsthera is a TypeScript MCP server for AI agent coordination. Thi

### context

- [Agent and wave MCP tools](notes/agent-and-wave-mcp-tools.md) — ## Overview  Monsthera has a small but important slice of MCP tools dedicated to
- [AgentService: Agent registry and session tracking](notes/agentservice-agent-registry-and-session-tracking.md) — ## Overview  `AgentService` is a derived-data service — it has no persistent age
- [CLI entrypoint and command routing](notes/cli-entrypoint-and-command-routing.md) — ## Overview  The CLI surface is the thinnest operational wrapper around the Mons
- [Context Pack Builder: Scoring, Diagnostics, and Mode-Specific Ranking](notes/context-pack-builder-scoring-diagnostics-and-mode-specific-ranking.md) — ## How build_context_pack Works  `buildContextPack()` in `SearchService` (`src/s
- [Core runtime state, logging, and startup bootstrap](notes/core-runtime-state-logging-and-startup-bootstrap.md) — ## Overview  The runtime-state layer is Monsthera's "last-known facts" cache for
- [Dashboard architecture and SPA routing](notes/dashboard-architecture-and-spa-routing.md) — # Dashboard Architecture and SPA Routing  ## Overview  The Monsthera dashboard i
- [Dashboard data flow and state management](notes/dashboard-data-flow-and-state-management.md) — # Dashboard data flow and state management  The Monsthera dashboard is a vanilla
- [Dashboard knowledge page UX flow](notes/dashboard-knowledge-page-ux-flow.md) — # Dashboard knowledge page UX flow  The knowledge page (`public/pages/knowledge.
- [Dashboard UI component library](notes/dashboard-ui-component-library.md) — # Dashboard UI Component Library  ## Overview  All reusable UI primitives live i
- [Dashboard work page UX flow](notes/dashboard-work-page-ux-flow.md) — # Dashboard work page UX flow  The work page (`public/pages/work.js`) manages wo
- [Dolt persistence layer: connection, schema, and health monitoring](notes/dolt-persistence-layer-connection-schema-and-health-monitoring.md) — ## Overview  Monsthera uses Dolt (a MySQL-compatible version-controlled database
- [Dolt repositories: search index and orchestration events](notes/dolt-repositories-search-index-and-orchestration-events.md) — ## Overview  After Phase 3 cleanup, only two Dolt repository classes remain: `Do
- [In-memory repositories and degraded-mode fallbacks](notes/in-memory-repositories-and-degraded-mode-fallbacks.md) — ## Overview  Monsthera's in-memory repositories serve two roles at once:  - dete
- [In-Memory Search Index: BM25 Scoring and Fallback Behavior](notes/in-memory-search-index-bm25-scoring-and-fallback-behavior.md) — ## Overview  `InMemorySearchIndexRepository` is the fallback search implementati
- [KnowledgeService: CRUD, search sync, and wiki integration](notes/knowledgeservice-crud-search-sync-and-wiki-integration.md) — # KnowledgeService  The `KnowledgeService` class is the central orchestrator fo
- [Markdown Frontmatter Serialization: Custom YAML Parser](notes/markdown-frontmatter-serialization-custom-yaml-parser.md) — ## Overview  Monsthera uses a **custom, zero-dependency YAML frontmatter parser*
- [Monsthera: Ingest Service for Local File Import](notes/monsthera-ingest-service-for-local-file-import.md) — ## Overview  The `IngestService` (`src/ingest/service.ts`) imports local files i
- [Monsthera: Markdown Serialization for Articles](notes/monsthera-markdown-serialization-for-articles.md) — ## Overview  All Monsthera articles (knowledge and work) are persisted as markdo
- [Search Ranking: BM25 + Semantic Hybrid with Trust Reranking](notes/search-ranking-bm25-semantic-hybrid-with-trust-reranking.md) — ## How Monsthera Search Ranking Works  Monsthera's `SearchService` (`src/search/
- [SearchService: Unified search, indexing, and context packs](notes/searchservice-unified-search-indexing-and-context-packs.md) — ## Overview  `SearchService` is the central search coordinator in Monsthera. It
- [StructureService: Code reference validation and graph analysis](notes/structureservice-code-reference-validation-and-graph-analysis.md) — # StructureService  The `StructureService` builds a knowledge graph from all kn
- [Trust Signal System: Legacy Content Identification and Search Demotion](notes/trust-signal-system-legacy-content-identification-and-search-demotion.md) — ## Purpose  The trust signal system ensures that migrated v2 content does not cr
- [Wave Planning and Execution System](notes/wave-planning-and-execution-system.md) — ## Wave Planning and Execution  The wave system is the core mechanism for batchi
- [Wiki surfaces and wikilink semantics](notes/wiki-surfaces-and-wikilink-semantics.md) — ## Overview  Monsthera's wiki is more than a folder of Markdown files. It has th
- [Work Article Guard System](notes/work-article-guard-system.md) — ## Overview  The guard system gates phase transitions in work articles. Guards a
- [Work Article Template System](notes/work-article-template-system.md) — ## Overview  The template system configures how work articles behave based on th
- [Work phase history and skipped-guard audit trail](notes/work-phase-history-and-skipped-guard-audit-trail.md) — ## Overview  Work articles are not just stored with a current phase; they also c

### decision

- [Monsthera stale code ref repair and orchestration audit](notes/monsthera-stale-code-ref-repair-and-orchestration-audit.md) — ## Summary Dead-code cleanup removed the unused wiki bookkeeper constructor fiel
- [Monsthera trust ranking and current-docs ingest](notes/monsthera-trust-ranking-and-current-docs-ingest.md) — ## Summary Monsthera reliability was improved by importing the current Monsthera

### design

- [Monsthera: Work Article Design](notes/monsthera-work-article-design.md) — ## Overview  Work articles are Monsthera's replacement for traditional tickets.

### guide

- [Dashboard pages and features](notes/dashboard-pages-and-features.md) — # Dashboard Pages and Features  ## Page Module Contract  Every page module expor
- [MCP Tool Catalog — Complete Reference](notes/mcp-tool-catalog-complete-reference.md) — ## Overview  Monsthera exposes **28 MCP tools** via stdio transport, organized i
- [Monsthera Agent Operating Guide](notes/monsthera-agent-operating-guide.md) — Monsthera works best when agents use it as an operational memory and coordinatio
- [Monsthera usage guide for humans and agents](notes/monsthera-usage-guide-for-humans-and-agents.md) — ## Mental model  Monsthera is a shared brain with an integrated backlog. It has
- [MonstheraV3 Docs](notes/monstherav3-docs.md) — ## Source - Path: `MonstheraV3/README.md` - Import mode: `summary`  ## Summary T

### plan

- [Monsthera v3: Implementation Plan](notes/monsthera-v3-implementation-plan.md) — ## Source - Path: `MonstheraV3/monsthera-v3-implementation-plan-final.md` - Impo

### reference

- [Dashboard REST API endpoints](notes/dashboard-rest-api-endpoints.md) — # Dashboard REST API Endpoints  ## Overview  All API routes are handled by `src/
- [Package entrypoints and barrel exports](notes/package-entrypoints-and-barrel-exports.md) — ## Overview  Monsthera uses barrel files as public-module boundaries. They are n

## Work
