# Monsthera Index

> Auto-generated catalog of 142 knowledge articles and 29 work articles.
> Last updated: 2026-06-11 00:48:49

## Knowledge

### architecture

- [ADR-001: Storage Model](notes/adr-001-storage-model.md) — ## Dual Storage Model  Monsthera uses a **dual storage architecture**: Markdown
- [ADR-002: Work Article Model](notes/adr-002-work-article-model.md) — ## Overview  The Work Article Model is Monsthera's structured task-tracking syst
- [ADR-003: Migration Boundary](notes/adr-003-migration-boundary.md) — ## Source - Path: `docs/adrs/003-migration-boundary.md`  ## Overview  ADR-003 de
- [ADR-004: Orchestration Model](notes/adr-004-orchestration-model.md) — ## ADR-004: Orchestration Model  Status: Accepted | Date: 2026-04-07  ### What s
- [ADR-005: Surface Boundaries](notes/adr-005-surface-boundaries.md) — ## Status Accepted — 2026-04-07  ## Decision Monsthera exposes three distinct su
- [ADR-006: Opt-in `snapshot_ready` Guard for `enrichment → implementation`](notes/adr-006-opt-in-snapshot-ready-guard-for-enrichment-implementation.md) — # ADR-006: Opt-in `snapshot_ready` Guard for `enrichment → implementation`  **St
- [ADR-007: Knowledge-Driven Policy Articles](notes/adr-007-policy-articles.md) — # ADR-007: Knowledge-Driven Policy Articles  **Status:** Accepted **Date:** 2026
- [ADR-008: Agent Dispatch Contract](notes/adr-008-agent-dispatch-contract.md) — # ADR-008: Agent Dispatch Contract  **Status:** Accepted **Date:** 2026-04-25 **
- [ADR-009: Convoys, Requires-as-Hard-Block, and Mid-Session Resync](notes/adr-009-convoys-requires-resync.md) — # ADR-009: Convoys, Requires-as-Hard-Block, and Mid-Session Resync  **Status:**
- [ADR-010: Orchestrator Ergonomics & Audit Tooling (PR A)](notes/adr-010-orchestrator-ergonomics-audit-tooling-pr-a.md) — # ADR-010: Orchestrator Ergonomics & Audit Tooling (PR A)  **Status:** Accepted
- [ADR-011: Orchestrator CLI Ergonomics (PR B)](notes/adr-011-orchestrator-cli-ergonomics-pr-b.md) — # ADR-011: Orchestrator CLI Ergonomics (PR B)  **Status:** Accepted **Date:** 20
- [ADR-012: Drift Prevention Closure (S5 PR B)](notes/adr-012-drift-prevention-closure.md) — # ADR-012: Drift Prevention Closure (S5 PR B)  **Status:** Accepted **Date:** 20
- [ADR-013: Convoy Hardening — get, provenance events, single-convoy invariant](notes/adr-013-convoy-hardening.md) — # ADR-013: Convoy Hardening — get, provenance events, single-convoy invariant  *
- [ADR-014: Convoy Dashboard — dedicated page, sidebar badge, lifecycle ribbon](notes/adr-014-convoy-dashboard.md) — # ADR-014: Convoy Dashboard — dedicated page, sidebar badge, lifecycle ribbon  *
- [ADR-014: Portable Workspace Operations](notes/adr-014-portable-workspace-operations.md) — # ADR-014: Portable Workspace Operations  ## Status  Accepted — 2026-04-26  ## C
- [ADR-015 Code Intelligence Strategy](notes/adr-015-code-intelligence-strategy.md) — ## Source - Path: `docs/adrs/015-code-intelligence-strategy.md` - Status: Accept
- [ADR-016: Self update rollback and doctor](notes/adr-016-self-update-rollback-and-doctor.md) — # ADR-016: Self update rollback and doctor  ## Status  Accepted — 2026-04-26  ##
- [ADR-017: Code Intelligence M3 — Lightweight Code Inventory](notes/adr-017-code-intelligence-m3-lightweight-inventory.md) — # ADR-017: Code Intelligence M3 — Lightweight Code Inventory  **Status:** Accept
- [ADR-018: Cognitive handoff sessions](notes/adr-018-cognitive-handoff-sessions.md) — # ADR-018: Cognitive handoff sessions  **Status:** Accepted **Date:** 2026-05-16
- [ADR-019: Agent-direct handoff (reversal of ADR-018 D2/D3)](notes/adr-019-agent-direct-handoff-reversal-of-adr-018-d2d3.md) — # ADR-019: Agent-direct handoff (reversal of ADR-018 D2/D3)  **Status:** Accepte
- [ADR-020: Typed / Custom Frontmatter Fields](notes/adr-020-typed-custom-frontmatter-fields.md) — # ADR-020: Typed / Custom Frontmatter Fields  **Status:** Accepted — implemented
- [Monsthera: Hybrid Knowledge Architecture v6](notes/monsthera-hybrid-knowledge-architecture-v6.md) — ## Overview  Monsthera is a TypeScript MCP server for AI agent coordination. Thi

### context

- [Agent and wave MCP tools](notes/agent-and-wave-mcp-tools.md) — ## Overview  Monsthera has a small but important slice of MCP tools dedicated to
- [AgentService: Agent registry and session tracking](notes/agentservice-agent-registry-and-session-tracking.md) — ## Overview  `AgentService` is a derived-data service — it has no persistent age
- [Auditoría integral 2026-06-10 — backlog priorizado post-M3](notes/auditora-integral-2026-06-10-backlog-priorizado-post-m3.md) — Auditoría completa sobre main @ caa6166 (post-M3, v3.0.0). Método: verificacione
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

- [Decisión C2: salience (PR-13b) descartado para siempre — inmedible por construcción y contraindicado por la evidencia de C1](notes/decisin-c2-salience-pr-13b-descartado-para-siempre-inmedible-por-construccin-y-contraindicado-por-la-evidencia-de-c1.md) — Cierra el deferred PR-13b (salience bonus en ranking, diferido en M3 por "eval s
- [Decision: agent dispatch contract — events, not spawning](notes/agent-dispatch-design-decisions.md) — ADR-008 captures the formal decision (event lifecycle, dispatcher shape). This n
- [Decision: convoy dashboard — panel, sidebar badge, ribbon](notes/convoy-dashboard-design-decisions.md) — ADR-014 captures the formal decisions: dedicated page, sidebar badge as the sing
- [Decision: convoy hardening — get, provenance events, single-convoy invariant](notes/convoy-hardening-design-decisions.md) — ADR-013 captures the formal decision (event types, the single-convoy invariant,
- [Decision: convoys, requires-as-hard-block, mid-session resync](notes/convoy-requires-resync-design-decisions.md) — ADR-009 captures the formal decision (convoy types, hard-block guard, new event
- [Monsthera stale code ref repair and orchestration audit](notes/monsthera-stale-code-ref-repair-and-orchestration-audit.md) — ## Summary Dead-code cleanup removed the unused wiki bookkeeper constructor fiel
- [Monsthera trust ranking and current-docs ingest](notes/monsthera-trust-ranking-and-current-docs-ingest.md) — ## Summary Monsthera reliability was improved by importing the current Monsthera
- [P2: Per-category staleness windows in insights.ts](notes/p2-per-category-staleness-windows-in-insightsts.md) — ## Problem The 2026-06-10 audit flagged 63 of 114 articles "stale". Staleness us
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

- [Dashboard REST API endpoints](notes/dashboard-rest-api-endpoints.md) — # Dashboard REST API Endpoints  ## Overview  Routing was split out of the old mo
- [Monsthera CLI Command Cheatsheet](notes/monsthera-cli-command-cheatsheet.md) — # Monsthera CLI Command Cheatsheet  Complete reference for the `monsthera` CLI s
- [Package entrypoints and barrel exports](notes/package-entrypoints-and-barrel-exports.md) — ## Overview  Monsthera uses barrel files as public-module boundaries. They are n

### research

- [Benchmark Methodology — Environment Snapshot + build_context_pack Impact](notes/monsthera-snapshot-benchmark-methodology.md) — Companion methodology for the benchmark spike `w-uvp3azdf`. Explains how to run
- [GitNexus UI and Graph Patterns Worth Reimagining](notes/gitnexus-ui-and-graph-patterns-worth-reimagining.md) — ## Summary  GitNexus is useful as product/UX inspiration for Monsthera, especial
- [IRIS Meta-Harness — Environment Bootstrapping and Implications for Monsthera](notes/iris-meta-harness-environment-bootstrapping-and-implications-for-monsthera.md) — Research note comparing Stanford IRIS Lab's `meta-harness-tbench2-artifact` ag
- [Monsthera vs GitNexus Code Exploration Evaluation](notes/monsthera-vs-gitnexus-code-exploration-evaluation.md) — ## Evaluation  Monsthera and GitNexus both expose search, graph, embeddings, and

### solution

- [Dogfood review (2026-05-29): CLI --help, version drift, codeRefs extractor, lint exemption, dashboard split](notes/dogfood-review-2026-05-29-cli-help-version-drift-coderefs-extractor-lint-exemption-dashboard-split.md) — A dogfood review of Monsthera using its own CLI (`monsthera doctor|lint|code|sta
- [P1 eval honesty — golden-set expansion + contamination guardrail](notes/p1-eval-honesty-golden-set-expansion-contamination-guardrail.md) — Wave 2 of the 2026-06-10 audit (see [[auditora-integral-2026-06-10-backlog-prior
- [P1 eval honesty — run-level engine detection + doctor liveness](notes/p1-eval-honesty-run-level-engine-detection-doctor-liveness.md) — Wave 2 (slice 2) of the 2026-06-10 audit (work `w-zluxybat`, branch `feat/p1-eva
- [PR P0 shipped — audit hardening (auth GET, host bind, SDK bump, CI gates)](notes/pr-p0-shipped-audit-hardening-auth-get-host-bind-sdk-bump-ci-gates.md) — Wave 1 de la auditoría 2026-06-10 (ver [[auditora-integral-2026-06-10-backlog-pr
- [PR P2 shipped — corpus & lint hygiene (ADR import, orphan FP fix, staleness por categoría)](notes/pr-p2-shipped-corpus-lint-hygiene-adr-import-orphan-fp-fix-staleness-por-categora.md) — Wave 3 de la auditoría 2026-06-10 (ver [[auditora-integral-2026-06-10-backlog-pr
- [PR-10: Config-driven ranking knobs](notes/pr10-config-ranking-knobs.md) — Fourth PR of M2; prerequisite for PR-11's reranker.  ## What shipped (main @ 2fc
- [PR-11: Relevance reranker stage](notes/pr11-reranker-stage.md) — Fifth PR of M2. Optional relevance-reranking stage for hybrid search; consumes t
- [PR-12: Embedding onboarding ergonomics (M2 close)](notes/pr12-embedding-onboarding.md) — Sixth and final PR of M2. Makes enabling semantic search a one-liner.  ## What s
- [PR-13a: Knowledge provenance (origin enum + doctor breakdown)](notes/pr13-provenance.md) — First half of **PR-13** (M3, knowledge-capability plan). Records where a knowled
- [PR-14a: Custom-frontmatter query filter (ADR-020 P2)](notes/pr14-custom-frontmatter-query.md) — Closes **gap 2 of ADR-020**: custom frontmatter is now *queryable*. First of two
- [PR-14b: Custom-frontmatter lint family (ADR-020 P3)](notes/pr14-custom-frontmatter-lint.md) — Closes **gap 3 of ADR-020**: custom frontmatter is now *validated*. Second of th
- [PR-15: Git/PR history ingestion (M3 close)](notes/pr15-git-ingestion.md) — Final PR of **M3**. Ingests git history into knowledge — one article per commit
- [PR-16: index navegable — filePath runtime + exclusión gitignore-aware (Banyan P0-AB)](notes/pr-16-index-navegable-filepath-runtime-exclusin-gitignore-aware-banyan-p0-ab.md) — Primer fix consumer-driven desde Banyan (corpus matemático Lean, 64+ artículos I
- [PR-17: precisión de orphan_citation — forma de ID + resolución por stem (Banyan P0-C)](notes/pr-17-precisin-de-orphan-citation-forma-de-id-resolucin-por-stem-banyan-p0-c.md) — Segundo fix consumer-driven Banyan (ver [[pr-16-index-navegable-filepath-runtime
- [PR-18: semantic onboarding honesto — enable-semantic verificado cross-repo (Banyan P1)](notes/pr-18-semantic-onboarding-honesto-enable-semantic-verificado-cross-repo-banyan-p1.md) — Tercer fix consumer-driven Banyan. Rama `feat/banyan-p1-semantic`. El "semantic
- [PR-19: Lean symbol extraction en el code inventory (Banyan P2)](notes/pr-19-lean-symbol-extraction-en-el-code-inventory-banyan-p2.md) — Cuarto fix consumer-driven Banyan. Rama `feat/banyan-p2-lean-inventory`. `code r
- [PR-20: work tracking quickstart para consumidores (Banyan P3, docs-only)](notes/pr-20-work-tracking-quickstart-para-consumidores-banyan-p3-docs-only.md) — Quinto y último fix consumer-driven Banyan. Rama `docs/banyan-p3-work-quickstart
- [PR-7: Context-pack ranking characterization pin](notes/pr7-context-pack-ranking-characterization.md) — First PR of M2 (knowledge-capability plan). Locks the context-pack ranking formu
- [PR-8: Consolidated corpus staleness report](notes/pr8-corpus-staleness-report.md) — Second PR of M2. Folds per-item freshness into one whole-corpus, read-only stale
- [PR-9: Deterministic cross-article contradiction detection](notes/pr9-contradiction-detection.md) — Third PR of M2. Surfaces when two corpus articles disagree on the same canonical
- [PR1: corpus tag-hygiene (write-path normalize + lint rule)](notes/pr1-corpus-tag-hygiene-write-path-normalize-lint-rule.md) — ## Problem  Creating an article with `--tags "'family:kriging', family:kriging,
- [PR2: knowledge CLI safety + ergonomics (dry-run, incremental tags, json, quiet)](notes/pr2-knowledge-cli-safety-ergonomics-dry-run-incremental-tags-json-quiet.md) — ## Summary  PR2 of the real-corpus dogfood follow-up — P1 CLI safety + ergonomic
- [Solution: PR P0 — audit hardening: README status, dashboard auth GET, SDK bump, coverage ratchet](notes/distilled-w-kw9xy2i5.md) — > Distilled from work [w-kw9xy2i5] on completion. Origin: `distilled`.  Wave 1 d
- [Solution: PR P1 — eval keystone: expansión del golden set + honestidad semántica](notes/distilled-w-zluxybat.md) — > Distilled from work [w-zluxybat] on completion. Origin: `distilled`.  Wave 2 d
- [Solution: Wave A: quick fixes consumer-driven — update() ID-named duplica + GUARD_FAILED mudo](notes/distilled-w-ymavjqkd.md) — > Distilled from work [w-ymavjqkd] on completion. Origin: `distilled`.  ## Objec
- [Solution: Wave B: DX quick wins — help ingest git, clocks inyectados, when-to-use en tools, ollama-client compartido](notes/distilled-w-4vc60xph.md) — > Distilled from work [w-4vc60xph] on completion. Origin: `distilled`.  ## Objec
- [Solution: Wave C: calidad de recuperación — fix-or-quarantine semantic, baseline honesto, salience, cf emission](notes/distilled-w-bjggjpsg.md) — > Distilled from work [w-bjggjpsg] on completion. Origin: `distilled`.  ## Objec
- [Solution: Wave D: dashboard UX — split router, responsive, search results-first, heroes, Sessions, eval card, self-host](notes/distilled-w-y0wuvaix.md) — > Distilled from work [w-y0wuvaix] on completion. Origin: `distilled`.  ## Objec
- [Solution: Wave E1: split de work/lint.ts en rules/ por finding type — luego PAUSA para review](notes/distilled-w-s16wia61.md) — > Distilled from work [w-s16wia61] on completion. Origin: `distilled`.  ## Objec
- [T5: Minimal-diff frontmatter write on knowledge update](notes/t5-minimal-diff-frontmatter-write-on-knowledge-update.md) — ## Summary  Final task (T5) of the real-corpus dogfood follow-up. Shipped on bra
- [Wave A1: write path honra filePath — update/delete sobre archivos ID-named](notes/wave-a1-write-path-honra-filepath-updatedelete-sobre-archivos-id-named.md) — Cierra el gotcha registrado en PR-16 (k-zv7qfvll): todo el write path resolvía s
- [Wave A2: GUARD_FAILED min_enrichment_met ahora nombra roles pendientes y remedios](notes/wave-a2-guard-failed-min-enrichment-met-ahora-nombra-roles-pendientes-y-remedios.md) — Cierra la fricción #1 del quickstart de work tracking (k-e9atys0k): `GUARD_FAILE
- [Wave B1: ingest git visible en help top-level + relojes deterministas en tests time-sensitive](notes/wave-b1-ingest-git-visible-en-help-top-level-relojes-deterministas-en-tests-time-sensitive.md) — Wave B1 (auditoría P3). Rama `fix/b1-ingest-help-flaky-clocks`, apilada sobre #1
- [Wave B2: "When to use" en las 69 tool descriptions MCP — schemas byte-idénticos](notes/wave-b2-when-to-use-en-las-69-tool-descriptions-mcp-schemas-byte-idnticos.md) — Wave B2 (auditoría P3). Rama `chore/b2-tool-descriptions-when-to-use`, apilada s
- [Wave B3: ollama-client compartido — la triplicación fetch+parse+timeout consolidada sin cambio de comportamiento](notes/wave-b3-ollama-client-compartido-la-triplicacin-fetchparsetimeout-consolidada-sin-cambio-de-comportamiento.md) — Wave B3 (auditoría P3). Rama `refactor/b3-ollama-client`, apilada sobre #155.  #
- [Wave C1: el colapso semántico era un mismatch de escala — NDCG 0.098 → 0.899, semantic ahora supera a bm25](notes/wave-c1-el-colapso-semntico-era-un-mismatch-de-escala-ndcg-0098-0899-semantic-ahora-supera-a-bm25.md) — Rama `fix/c1-hybrid-scale-mismatch`, apilada sobre #156. **La primera medición r
- [Wave C3: escalares de extraFrontmatter como términos de búsqueda — cierra el último deferred de ADR-020](notes/wave-c3-escalares-de-extrafrontmatter-como-trminos-de-bsqueda-cierra-el-ltimo-deferred-de-adr-020.md) — Rama `feat/c3-cf-search-terms`, apilada sobre #158. Cierra el deferred "cf searc
- [Wave D0: router del dashboard partido en routes/ por dominio — 1433 → 189 líneas, cero cambio de comportamiento](notes/wave-d0-router-del-dashboard-partido-en-routes-por-dominio-1433-189-lneas-cero-cambio-de-comportamiento.md) — Rama `refactor/d0-dashboard-routes`, apilada sobre #159. El archivo más grande d
- [Wave D1: responsive del sidebar, search results-first, y el badge fantasma de Convoys](notes/wave-d1-responsive-del-sidebar-search-results-first-y-el-badge-fantasma-de-convoys.md) — Rama `feat/d1-dashboard-ux-prio1`, apilada sobre #160. Los tres hallazgos PRIO-1
- [Wave D2: página Sessions, card de retrieval-quality, y heroes colapsables persistentes](notes/wave-d2-pgina-sessions-card-de-retrieval-quality-y-heroes-colapsables-persistentes.md) — Rama `feat/d2-dashboard-features`, apilada sobre #161. Hallazgos (c)/(e)/(f) del
- [Wave D3: assets self-hosted (cero CDN), footer informativo, y las 7 notas dashboard-* refrescadas](notes/wave-d3-assets-self-hosted-cero-cdn-footer-informativo-y-las-7-notas-dashboard-refrescadas.md) — Rama `chore/d3-dashboard-polish`, apilada sobre #162. Cierra Wave D.  ## (g) Pol
- [Wave E1: work/lint.ts partido en rules/ por familia — 871 → 408, findings del corpus byte-idénticos](notes/wave-e1-worklintts-partido-en-rules-por-familia-871-408-findings-del-corpus-byte-idnticos.md) — Rama `refactor/e1-lint-rules`, apilada sobre #163. Segundo archivo del backlog d
- [Wave E2: createContainer partido en factories por subsistema — 697 → 519, orden de construcción byte-a-byte](notes/wave-e2-createcontainer-partido-en-factories-por-subsistema-697-519-orden-de-construccin-byte-a-byte.md) — Rama `refactor/e2-container-factories` desde main post-#165. Tercer split del ba
- [Wave E3: structure/service.ts — citation-analyzer, staleness, code-ref-indexer y tag-edge-builder extraídos (1337 → 874)](notes/wave-e3-structureservicets-citation-analyzer-staleness-code-ref-indexer-y-tag-edge-builder-extrados-1337-874.md) — Rama `refactor/e3-structure-modules` desde main post-#167. Cuarto split del back

## Work

### planning (2)

- [findBySlug path-derivado: get por slug y collision-check de create fallan en archivos ID-named](work-articles/w-c09d7wa9.md) [medium] — ## Objective  Descubierto durante Wave A1 (write path). `Fil
- [Golden set: re-revisar forbiddenArticleIds de casos dashboard tras el refresh D3](work-articles/w-j7ao5fak.md) [low] — ## Objective  El cierre de Wave D midió contamination 0.7273

### done (26)

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
- [PR P0 — audit hardening: README status, dashboard auth GET, SDK bump, coverage ratchet](work-articles/w-kw9xy2i5.md) [high] — Wave 1 de la auditoría 2026-06-10 (ver k-3zo9w9dg). Rama `fi
- [PR P1 — eval keystone: expansión del golden set + honestidad semántica](work-articles/w-zluxybat.md) [high] — Wave 2 de la auditoría 2026-06-10 (ver k-3zo9w9dg). Rama `fe
- [refactor: lock file-repository read-modify-write to prevent lost updates](work-articles/w-mc21yp9s.md) [critical] — ## Issue  `FileSystemKnowledgeArticleRepository.update` and
- [refactor: replace throw new Error in CLI doctor commands with Result propagation](work-articles/w-zuxnfk7f.md) [high] — ## Issue  Several CLI command modules throw raw `Error` inst
- [Simplificar instalación, actualización y portabilidad del workspace](work-articles/w-zxi617cw.md) [high] — ## Objetivo Crear una superficie operacional oficial para Mo
- [Wave A: quick fixes consumer-driven — update() ID-named duplica + GUARD_FAILED mudo](work-articles/w-ymavjqkd.md) [high] — ## Objective  Dos quick fixes consumer-driven descubiertos e
- [Wave B: DX quick wins — help ingest git, clocks inyectados, when-to-use en tools, ollama-client compartido](work-articles/w-4vc60xph.md) [medium] — ## Objective  Tres quick wins DX de la auditoría (k-3zo9w9dg
- [Wave C: calidad de recuperación — fix-or-quarantine semantic, baseline honesto, salience, cf emission](work-articles/w-bjggjpsg.md) [high] — ## Objective  (Ver historial: C1 reformulado por el descubri
- [Wave D: dashboard UX — split router, responsive, search results-first, heroes, Sessions, eval card, self-host](work-articles/w-y0wuvaix.md) [medium] — ## Objective  (Original en historial.) Hallazgos (a)-(h) del
- [Wave E1: split de work/lint.ts en rules/ por finding type — luego PAUSA para review](work-articles/w-s16wia61.md) [medium] — ## Objective  (Original en historial.) Split de `src/work/li

### cancelled (1)

- [Benchmark: snapshot + build_context_pack cold-start impact](work-articles/w-uvp3azdf.md) [medium] — ## Objective  Quantify whether the environment-snapshot + `b
