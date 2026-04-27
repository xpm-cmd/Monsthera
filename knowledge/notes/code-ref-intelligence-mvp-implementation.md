---
id: k-6qapdb1a
title: Code-Ref Intelligence MVP Implementation
slug: code-ref-intelligence-mvp-implementation
category: implementation
tags: [code-intelligence, code-refs, mcp-tools, implementation, mvp]
codeRefs: [src/code-intelligence/service.ts, src/code-intelligence/index.ts, src/tools/code-intelligence-tools.ts, src/core/container.ts, src/server.ts, tests/unit/code-intelligence/service.test.ts, docs/adrs/015-code-intelligence-strategy.md]
references: [adr-015-code-intelligence-strategy, monsthera-vs-gitnexus-code-exploration-evaluation]
createdAt: 2026-04-26T11:52:13.257Z
updatedAt: 2026-04-26T11:52:13.257Z
---

## Summary

Implemented the first slice of ADR-015: code-ref intelligence without AST parsing or new runtime dependencies.

## Added

- `CodeIntelligenceService` in `src/code-intelligence/service.ts`
- MCP tools in `src/tools/code-intelligence-tools.ts`
  - `code_get_ref`
  - `code_find_owners`
  - `code_analyze_impact`
  - `code_detect_changes`
- New `StructureService.buildCodeRefOwnerIndex()` method consumed by code-intelligence to avoid duplicating ref-to-owner index logic.
- Helpers `normalizeCodeRefPath` and `extractLineAnchor` in `src/core/code-refs.ts` shared by both services.
- Constant `POLICY_CATEGORY` in `src/knowledge/schemas.ts` to replace `"policy"` magic strings.
- Constant `MAX_CODE_REF_LENGTH` in `src/tools/validation.ts`.
- Container wiring via `codeIntelligenceService` (depends on `structureService`).
- Tool registry wiring in `src/server.ts`.
- Unit coverage in `tests/unit/code-intelligence/service.test.ts` and `tests/unit/tools/code-intelligence-tools.test.ts`.

## Behavior

The service delegates ref → owners lookups to `StructureService.buildCodeRefOwnerIndex()`, which normalizes refs once and returns a `Map<normalizedRef, Set<ownerNodeId>>` plus the article objects for enrichment. Code intelligence layers exact + directory-prefix matching, a word-boundary policy-content fallback (only for targets ≥6 chars), and risk scoring on top of that index.

Path resolution rejects out-of-repo references (both `..` traversal and absolute paths outside the repo root); those refs surface `outOfRepo: true, exists: false` without ever calling `fs.stat`. Line anchors (`#L42`, `:42:5`) are preserved separately on `CodeRefDetail.lineAnchor` so callers don't lose the anchor while matching by path.

Active-work classification uses a whitelist (`planning`, `enrichment`, `implementation`, `review`) instead of a blacklist so future phases don't silently count as active. Risk scoring keeps `implementation` and `review` as the high-risk phases per ADR-015 D2.

`code_detect_changes` intentionally accepts `changed_paths` from the client or harness instead of shelling out to git from the MCP server. Empty arrays are rejected with `VALIDATION_FAILED` so a misconfigured client can't silently no-op. A CLI wrapper will add git-diff capture in Milestone 2.

## Boundary

This is not AST/call-graph intelligence. It is operational code intelligence over Monsthera's existing durable context. The next step is CLI/dashboard exposure and then lightweight inventory/provider bridge work.

## Tool naming

The four tools follow the canonical `code_<verb>` convention shared with other Monsthera tool surfaces (`convoy_*`, `agent_*`, `events_*`, `wave_*`). The original ADR draft used verb-first names (`get_code_ref`, `analyze_code_ref_impact`, `detect_changed_code_refs`); these were renamed before the M1 ship so they would not need a breaking rename in M4 when the provider bridge stable names land.