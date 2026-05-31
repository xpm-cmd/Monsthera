# Monsthera Index

> Auto-generated catalog of 92 knowledge articles and 20 work articles.
> Last updated: 2026-05-31 10:51:51

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
- [Cognitive handoff sessions — system design and state](notes/cognitive-handoff-sessions.md) — # Cognitive handoff sessions  **Status:** shipped in PRs [#104](https://github.c
- [Context Pack Builder: Scoring, Diagnostics, and Mode-Specific Ranking](notes/context-pack-builder-scoring-diagnostics-and-mode-specific-ranking.md) — ## How build_context_pack Works  `buildContextPack()` in `SearchService` (`src/s
- [Core runtime state, logging, and startup bootstrap](notes/core-runtime-state-logging-and-startup-bootstrap.md) — ## Overview  The runtime-state layer is Monsthera's "last-known facts" cache for
- [Dashboard architecture and SPA routing](notes/dashboard-architecture-and-spa-routing.md) — # Dashboard Architecture and SPA Routing  ## Overview  The Monsthera dashboard i
- [Dashboard data flow and state management](notes/dashboard-data-flow-and-state-management.md) — # Dashboard data flow and state management  The Monsthera dashboard is a vanilla
- [Dashboard knowledge page UX flow](notes/dashboard-knowledge-page-ux-flow.md) — # Dashboard knowledge page UX flow  The knowledge page (`public/pages/knowledge.
- [Dashboard UI component library](notes/dashboard-ui-component-library.md) — # Dashboard UI Component Library  ## Overview  All reusable UI primitives live i
- [Dashboard work page UX flow](notes/dashboard-work-page-ux-flow.md) — # Dashboard work page UX flow  The work page (`public/pages/work.js`) manages wo
- [Demo: Hedera v1 drift sample](notes/demo-drift-hedera.md) — # Demo article — intentional anti-example  This article retains a sample of a wr
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

### gotcha

- [Coverage validator — round 4 calibration learnings](notes/coverage-validator-round-4-calibration.md) — # Coverage validator — round 4 calibration learnings  Captures what surfaced whi
- [Phase 3c shipping — non-obvious learnings](notes/phase-3c-shipping-non-obvious-learnings.md) — # Phase 3c shipping — non-obvious learnings  These are the things that surfaced
- [Phase 3d + 3e shipping — non-obvious learnings](notes/phase-3d-3e-shipping-non-obvious-learnings.md) — # Phase 3d + 3e shipping — non-obvious learnings  These are the things that surf
- [Phase 4a + 4b shipping — non-obvious learnings](notes/phase-4a-4b-shipping-non-obvious-learnings.md) — # Phase 4a + 4b shipping — non-obvious learnings  Same shape as the Phase 3d+3e

### guide

- [Dashboard pages and features](notes/dashboard-pages-and-features.md) — # Dashboard Pages and Features  ## Page Module Contract  Every page module expor
- [Drift Prevention — Design](notes/drift-prevention-design.md) — # Drift Prevention — Design  Closure note for the Hedera v1 retrospective. Pairs
- [MCP Tool Catalog — Complete Reference](notes/mcp-tool-catalog-complete-reference.md) — ## Overview  Monsthera exposes **31 MCP tools** via stdio transport, organized i
- [Monsthera Agent Operating Guide](notes/monsthera-agent-operating-guide.md) — Monsthera works best when agents use it as an operational memory and coordinatio
- [Monsthera usage guide for humans and agents](notes/monsthera-usage-guide-for-humans-and-agents.md) — ## Mental model  Monsthera is a shared brain with an integrated backlog. It has
- [MonstheraV3 Docs](notes/monstherav3-docs.md) — ## ⚠️ Status snapshot  This article is an imported summary of the original v3 de

### handoff

- [Handoff: 2026-05-13 claude-code (1 min)](notes/handoff-ses-20260513-003933-claude-code.md) — > **Session** `ses-20260513-003933-claude-code` · agent `claude-code` · 1 min >
- [Handoff: 2026-05-13 claude-code (1 min)](notes/handoff-ses-20260513-125013-claude-code.md) — > **Session** `ses-20260513-125013-claude-code` · agent `claude-code` · 1 min >
- [Handoff: 2026-05-13 claude-code (Phase 3d/3e/4a/4b shipped)](notes/handoff-ses-20260513-125609-claude-code.md) — > **Session** `ses-20260513-125609-claude-code` · agent `claude-code` · 0 min >
- [Handoff: 2026-05-15 claude-code (0 min)](notes/handoff-ses-20260515-131418-claude-code.md) — > **Session** `ses-20260515-131418-claude-code` · agent `claude-code` · 0 min >
- [Handoff: 2026-05-15 claude-code (0 min)](notes/handoff-ses-20260515-131606-claude-code.md) — > **Session** `ses-20260515-131606-claude-code` · agent `claude-code` · 0 min >
- [Handoff: 2026-05-15 claude-code (0 min)](notes/handoff-ses-20260515-131951-claude-code.md) — > **Session** `ses-20260515-131951-claude-code` · agent `claude-code` · 0 min >
- [Handoff: 2026-05-16 claude-code (0 min)](notes/handoff-ses-20260516-055350-claude-code.md) — > **Session** `ses-20260516-055350-claude-code` · agent `claude-code` · 0 min >
- [Handoff: 2026-05-16 claude-code (0 min)](notes/handoff-ses-20260516-060530-claude-code.md) — > **Session** `ses-20260516-060530-claude-code` · agent `claude-code` · 0 min >
- [Handoff: 2026-05-16 claude-code (0 min)](notes/handoff-ses-20260516-061335-claude-code.md) — > **Session** `ses-20260516-061335-claude-code` · agent `claude-code` · 0 min >
- [Handoff: 2026-05-16 claude-code (0 min)](notes/handoff-ses-20260516-061801-claude-code.md) — > **Session** `ses-20260516-061801-claude-code` · agent `claude-code` · 0 min >
- [Handoff: 2026-05-16 claude-code (3 min)](notes/handoff-ses-20260516-042501-claude-code.md) — > **Session** `ses-20260516-042501-claude-code` · agent `claude-code` · 3 min >
- [Handoff: 2026-05-17 claude-code (2 min)](notes/handoff-ses-20260517-122214-claude-code.md) — > **Session** `ses-20260517-122214-claude-code` · agent `claude-code` · 2 min >

### implementation

- [Code Intelligence M3 Implementation](notes/code-intelligence-m3-implementation.md) — ## Summary  Shipped Milestone 3 of ADR-015 — a lightweight, multi-language symbo
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

### solution

- [Dogfood review (2026-05-29): CLI --help, version drift, codeRefs extractor, lint exemption, dashboard split](notes/dogfood-review-2026-05-29-cli-help-version-drift-coderefs-extractor-lint-exemption-dashboard-split.md) — A dogfood review of Monsthera using its own CLI (`monsthera doctor|lint|code|sta
- [PR-10: Config-driven ranking knobs](notes/pr10-config-ranking-knobs.md) — Fourth PR of M2; prerequisite for PR-11's reranker.  ## What shipped (main @ 2fc
- [PR-11: Relevance reranker stage](notes/pr11-reranker-stage.md) — Fifth PR of M2. Optional relevance-reranking stage for hybrid search; consumes t
- [PR-12: Embedding onboarding ergonomics (M2 close)](notes/pr12-embedding-onboarding.md) — Sixth and final PR of M2. Makes enabling semantic search a one-liner.  ## What s
- [PR-13a: Knowledge provenance (origin enum + doctor breakdown)](notes/pr13-provenance.md) — First half of **PR-13** (M3, knowledge-capability plan). Records where a knowled
- [PR-14a: Custom-frontmatter query filter (ADR-020 P2)](notes/pr14-custom-frontmatter-query.md) — Closes **gap 2 of ADR-020**: custom frontmatter is now *queryable*. First of two
- [PR-7: Context-pack ranking characterization pin](notes/pr7-context-pack-ranking-characterization.md) — First PR of M2 (knowledge-capability plan). Locks the context-pack ranking formu
- [PR-8: Consolidated corpus staleness report](notes/pr8-corpus-staleness-report.md) — Second PR of M2. Folds per-item freshness into one whole-corpus, read-only stale
- [PR-9: Deterministic cross-article contradiction detection](notes/pr9-contradiction-detection.md) — Third PR of M2. Surfaces when two corpus articles disagree on the same canonical
- [PR1: corpus tag-hygiene (write-path normalize + lint rule)](notes/pr1-corpus-tag-hygiene-write-path-normalize-lint-rule.md) — ## Problem  Creating an article with `--tags "'family:kriging', family:kriging,
- [PR2: knowledge CLI safety + ergonomics (dry-run, incremental tags, json, quiet)](notes/pr2-knowledge-cli-safety-ergonomics-dry-run-incremental-tags-json-quiet.md) — ## Summary  PR2 of the real-corpus dogfood follow-up — P1 CLI safety + ergonomic
- [T5: Minimal-diff frontmatter write on knowledge update](notes/t5-minimal-diff-frontmatter-write-on-knowledge-update.md) — ## Summary  Final task (T5) of the real-corpus dogfood follow-up. Shipped on bra

## Work

### done (19)

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
- [Implement Code Intelligence M3 — Lightweight Code Inventory](work-articles/w-w7yhmqse.md) [high] — ## Objective  Implement Milestone 3 of ADR-015 (Code Intelli
- [Observational benchmark: Monsthera retrieval paths vs. grep](work-articles/w-dzur84o8.md) [medium] — ## Objective  Capture an observational data point comparing
- [Opt-in ready_to_implement guard consuming environment snapshots](work-articles/w-y988ky96.md) [medium] — ## Objective  Add a template-opt-in guard that blocks the `e
- [refactor: lock file-repository read-modify-write to prevent lost updates](work-articles/w-mc21yp9s.md) [critical] — ## Issue  `FileSystemKnowledgeArticleRepository.update` and
- [refactor: replace throw new Error in CLI doctor commands with Result propagation](work-articles/w-zuxnfk7f.md) [high] — ## Issue  Several CLI command modules throw raw `Error` inst
- [Simplificar instalación, actualización y portabilidad del workspace](work-articles/w-zxi617cw.md) [high] — ## Objetivo Crear una superficie operacional oficial para Mo

### cancelled (1)

- [Benchmark: snapshot + build_context_pack cold-start impact](work-articles/w-uvp3azdf.md) [medium] — ## Objective  Quantify whether the environment-snapshot + `b
