# Monsthera Index

> Auto-generated catalog of 62 knowledge articles and 20 work articles.
> Last updated: 2026-04-28 12:35:47

## Knowledge

### architecture

- [ADR-001: Storage Model](notes/adr-001-storage-model.md) — ## Dual Storage Model  Monsthera uses a **dual storage architecture**: Markdown
- [ADR-002: Work Article Model](notes/adr-002-work-article-model.md) — ## Overview  The Work Article Model is Monsthera's structured task-tracking syst
- [ADR-003: Migration Boundary](notes/adr-003-migration-boundary.md) — ## Source - Path: `docs/adrs/003-migration-boundary.md`  ## Overview  ADR-003 de
- [ADR-004: Orchestration Model](notes/adr-004-orchestration-model.md) — ## ADR-004: Orchestration Model  Status: Accepted | Date: 2026-04-07  ### What s
- [ADR-005: Surface Boundaries](notes/adr-005-surface-boundaries.md) — ## Status Accepted — 2026-04-07  ## Decision Monsthera exposes three distinct su
- [ADR-015 Code Intelligence Strategy](notes/adr-015-code-intelligence-strategy.md) — ## Source - Path: `docs/adrs/015-code-intelligence-strategy.md` - Status: Accept
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
- [Demo: Hedera v1 drift sample](notes/demo-drift-hedera.md) — # Demo article — intentional anti-example  This article exists so `pnpm demo:loc
- [Dolt persistence layer: connection, schema, and health monitoring](notes/dolt-persistence-layer-connection-schema-and-health-monitoring.md) — ## Overview  Monsthera uses Dolt (a MySQL-compatible version-controlled database
- [Dolt repositories: search index and orchestration events](notes/dolt-repositories-search-index-and-orchestration-events.md) — ## Overview  There are now three Dolt repository classes: `DoltSearchIndexReposi
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

- [Decision: agent dispatch contract — events, not spawning](notes/agent-dispatch-design-decisions.md) — ADR-008 captures the formal decision (event lifecycle, dispatcher shape). This n
- [Decision: convoy dashboard — panel, sidebar badge, ribbon](notes/convoy-dashboard-design-decisions.md) — ADR-014 captures the formal decisions: dedicated page, sidebar badge as the sing
- [Decision: convoy hardening — get, provenance events, single-convoy invariant](notes/convoy-hardening-design-decisions.md) — ADR-013 captures the formal decision (event types, the single-convoy invariant,
- [Decision: convoys, requires-as-hard-block, mid-session resync](notes/convoy-requires-resync-design-decisions.md) — ADR-009 captures the formal decision (convoy types, hard-block guard, new event
- [Monsthera stale code ref repair and orchestration audit](notes/monsthera-stale-code-ref-repair-and-orchestration-audit.md) — ## Summary Dead-code cleanup removed the unused wiki bookkeeper constructor fiel
- [Monsthera trust ranking and current-docs ingest](notes/monsthera-trust-ranking-and-current-docs-ingest.md) — ## Summary Monsthera reliability was improved by importing the current Monsthera
- [S5 plan: convoy dashboard](notes/s5-plan-convoy-dashboard.md) — # S5 plan: convoy dashboard (S4 v2)  S4 v1 (PR #86) closed the operational loop

### design

- [Monsthera: Work Article Design](notes/monsthera-work-article-design.md) — ## Overview  Work articles are Monsthera's replacement for traditional tickets.

### guide

- [Dashboard pages and features](notes/dashboard-pages-and-features.md) — # Dashboard Pages and Features  ## Page Module Contract  Every page module expor
- [Drift Prevention — Design](notes/drift-prevention-design.md) — # Drift Prevention — Design  Closure note for the Hedera v1 retrospective. Pairs
- [MCP Tool Catalog — Complete Reference](notes/mcp-tool-catalog-complete-reference.md) — ## Overview  Monsthera exposes **31 MCP tools** via stdio transport, organized i
- [Monsthera Agent Operating Guide](notes/monsthera-agent-operating-guide.md) — Monsthera works best when agents use it as an operational memory and coordinatio
- [Monsthera usage guide for humans and agents](notes/monsthera-usage-guide-for-humans-and-agents.md) — ## Mental model  Monsthera is a shared brain with an integrated backlog. It has
- [MonstheraV3 Docs](notes/monstherav3-docs.md) — ## ⚠️ Status snapshot  This article is an imported summary of the original v3 de

### implementation

- [Code-Ref Intelligence M2 Implementation](notes/code-ref-intelligence-m2-implementation.md) — ## Summary  Shipped Milestone 2 of ADR-015 — code-ref intelligence at the CLI an
- [Code-Ref Intelligence MVP Implementation](notes/code-ref-intelligence-mvp-implementation.md) — ## Summary  Implemented the first slice of ADR-015: code-ref intelligence withou

### plan

- [Monsthera v3: Implementation Plan](notes/monsthera-v3-implementation-plan.md) — ## ⚠️ Status snapshot  This plan reflects the alpha.3 / alpha.4 implementation a

### policy

| Policy | Templates | Transition | Requires Roles | Requires Articles |
|--------|-----------|------------|----------------|-------------------|
| [Anti-Example Registry](notes/anti-example-registry.md) | — | — | — | — |
| [Canonical Values Registry](notes/canonical-values.md) | — | — | — | — |
| [Policy: feature articles touching auth require security enrichment](notes/policy-example-security-enrichment.md) | feature | enrichment → implementation | security | — |

### reference

- [Dashboard REST API endpoints](notes/dashboard-rest-api-endpoints.md) — # Dashboard REST API Endpoints  ## Overview  All API routes are handled by `src/
- [Monsthera CLI Command Cheatsheet](notes/monsthera-cli-command-cheatsheet.md) — # Monsthera CLI Command Cheatsheet  Complete reference for the `monsthera` CLI s
- [Package entrypoints and barrel exports](notes/package-entrypoints-and-barrel-exports.md) — ## Overview  Monsthera uses barrel files as public-module boundaries. They are n

### research

- [Benchmark Methodology — Environment Snapshot + build_context_pack Impact](notes/monsthera-snapshot-benchmark-methodology.md) — Companion methodology for the benchmark spike `w-uvp3azdf`. Explains how to run
- [GitNexus UI and Graph Patterns Worth Reimagining](notes/gitnexus-ui-and-graph-patterns-worth-reimagining.md) — ## Summary  GitNexus is useful as product/UX inspiration for Monsthera, especial
- [IRIS Meta-Harness — Environment Bootstrapping and Implications for Monsthera](notes/iris-meta-harness-environment-bootstrapping-and-implications-for-monsthera.md) — Research note comparing Stanford IRIS Lab's `meta-harness-tbench2-artifact` ag
- [Monsthera vs GitNexus Code Exploration Evaluation](notes/monsthera-vs-gitnexus-code-exploration-evaluation.md) — ## Evaluation  Monsthera and GitNexus both expose search, graph, embeddings, and

## Work

### implementation (1)

- [Implement Code Intelligence M3 — Lightweight Code Inventory](work-articles/w-w7yhmqse.md) [high] — ## Objective  Implement Milestone 3 of ADR-015 (Code Intelli

### done (18)

- [Add environment_snapshot MCP tool and snapshot-aware context pack](work-articles/w-0ieze72s.md) [medium] — ## Objective  Give agents using Monsthera the cold-start s
- [Agent-facing docs and recovery hints for the snapshot surface](work-articles/w-ksaf2rcr.md) [medium] — ## Objective  Close the three UX gaps a cold-start agent hit
- [Close out snapshot follow-ups + cut 3.0.0-alpha.5](work-articles/w-21c2n6q5.md) [medium] — ## Objective  Close the open lifecycle state across the five
- [Dashboard snapshot-diff endpoint and drift banner](work-articles/w-r85lzqhv.md) [medium] — ## Objective  Give an agent resuming a work article in \`imp
- [Dolt persistence for environment snapshots](work-articles/w-guptmc33.md) [high] — ## Objective  Make environment snapshots persist across Mons
- [feat: workspace schema migration runner for future schema bumps](work-articles/w-z0o5hfx9.md) [high] — ## Issue  The workspace manifest carries a `workspaceSchemaV
- [fix: $EDITOR command injection via whitespace split](work-articles/w-49aol9fa.md) [critical] — ## Issue  `$EDITOR` / `$VISUAL` are split on whitespace and
- [fix: dashboard wildcard CORS + token in <meta> enables CSRF](work-articles/w-pd3211af.md) [critical] — ## Issue  The dashboard HTTP server returns `Access-Control-
- [fix: knowledge create slug TOCTOU loses articles on parallel create](work-articles/w-5zsmz0f7.md) [high] — ## Issue  `FileSystemKnowledgeArticleRepository.create()` ch
- [fix: make Dolt → in-memory fallback opt-in instead of silent](work-articles/w-qqzud6wf.md) [high] — ## Issue  When `config.storage.doltEnabled = true` but Dolt
- [fix: process command validation by substring is spoofable](work-articles/w-8qeo1wwj.md) [high] — ## Issue  `validateProcessCommand()` matches a managed proce
- [fix: workspace backup captures inconsistent Dolt snapshot](work-articles/w-df869qxf.md) [critical] — ## Issue  `workspace backup` calls `fs.cp(.monsthera/dolt, b
- [fix: workspace restore corrupts Dolt when daemon is running](work-articles/w-kppfuyle.md) [critical] — ## Issue  `workspace restore --force` deletes and recreates
- [Observational benchmark: Monsthera retrieval paths vs. grep](work-articles/w-dzur84o8.md) [medium] — ## Objective  Capture an observational data point comparing
- [Opt-in ready_to_implement guard consuming environment snapshots](work-articles/w-y988ky96.md) [medium] — ## Objective  Add a template-opt-in guard that blocks the `e
- [refactor: lock file-repository read-modify-write to prevent lost updates](work-articles/w-mc21yp9s.md) [critical] — ## Issue  `FileSystemKnowledgeArticleRepository.update` and
- [refactor: replace throw new Error in CLI doctor commands with Result propagation](work-articles/w-zuxnfk7f.md) [high] — ## Issue  Several CLI command modules throw raw `Error` inst
- [Simplificar instalación, actualización y portabilidad del workspace](work-articles/w-zxi617cw.md) [high] — ## Objetivo Crear una superficie operacional oficial para Mo

### cancelled (1)

- [Benchmark: snapshot + build_context_pack cold-start impact](work-articles/w-uvp3azdf.md) [medium] — ## Objective  Quantify whether the environment-snapshot + `b
