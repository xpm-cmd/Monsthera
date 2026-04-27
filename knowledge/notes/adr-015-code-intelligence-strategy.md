---
id: k-quo5tdc1
title: ADR-015 Code Intelligence Strategy
slug: adr-015-code-intelligence-strategy
category: architecture
tags: [adr, code-intelligence, code-refs, agents, impact-analysis, provider-bridge]
codeRefs: [docs/adrs/015-code-intelligence-strategy.md, src/structure/service.ts, src/search/service.ts, src/tools/structure-tools.ts, src/tools/search-tools.ts, src/core/container.ts, src/server.ts]
references: [monsthera-vs-gitnexus-code-exploration-evaluation, gitnexus-ui-and-graph-patterns-worth-reimagining]
createdAt: 2026-04-26T11:47:32.622Z
updatedAt: 2026-04-26T11:47:32.622Z
---

## Source
- Path: `docs/adrs/015-code-intelligence-strategy.md`
- Status: Accepted

## Summary

Monsthera should become code-intelligent through layers, not by immediately cloning a full code graph engine. The strategy preserves Monsthera's durable markdown-backed memory and work orchestration while adding progressively deeper code awareness.

## Capability ladder

1. Existing operational code context: `codeRefs`, `build_context_pack`, stale code-ref validation, snapshots, work phases, policies, and implementation evidence.
2. Code-ref intelligence: add tools that answer which knowledge, work, policies, events, and active phases are affected by a file or changed path. This requires no AST parser.
3. Lightweight code inventory: cache files, directories, conservative symbols, imports, tool handlers, and route-like facts under `.monsthera/cache/` as derived state.
4. Pluggable code graph provider: expose stable Monsthera tools like `code_query`, `code_context`, `code_impact`, and `detect_code_changes` while delegating deep AST/call-graph work to an optional provider.
5. Agent workflow guidance: append next-step hints to MCP responses so agents naturally run context, impact, snapshot, and review checks at the right phase.
6. Policy integration: allow policies to require code intelligence checks before review or done.

## Near-term milestone

Start with Code-Ref Impact. Add a `CodeIntelligenceService` backed by existing repos and `StructureService` (specifically the new `buildCodeRefOwnerIndex()` method); expose MCP tools `code_get_ref`, `code_find_owners`, `code_analyze_impact`, and `code_detect_changes`. CLI and dashboard surfaces are deferred to Milestone 2.

## Product stance

Monsthera should not start with a native full AST parser in core. Full code graph parsing is valuable, but it should enter through a provider bridge so Monsthera remains small, auditable, and focused on agent coordination.