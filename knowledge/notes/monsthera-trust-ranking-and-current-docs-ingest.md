---
id: k-t2ihkk5i
title: Monsthera trust ranking and current-docs ingest
slug: monsthera-trust-ranking-and-current-docs-ingest
category: decision
tags: [monsthera-v3, search-trust, knowledge-hygiene]
codeRefs: [src/search/service.ts, src/core/article-trust.ts, src/cli/doctor-commands.ts, src/ingest/service.ts]
references: []
createdAt: 2026-04-10T23:05:13.731Z
updatedAt: 2026-04-10T23:05:13.731Z
---

## Summary
Monsthera reliability was improved by importing the current MonstheraV3 docs and ADRs as source-linked knowledge articles, and by demoting migrated v2/Agora articles during search unless the query explicitly asks for legacy context.

## Legacy detection
Articles tagged with migration markers like v2-source:, v2:, or migration-hash: are treated as legacy migration context. Work migrated by the migration author is also treated as legacy.

## Ranking behavior
Default search and build_context_pack now prefer current source-linked documentation over migrated Agora-era notes for ordinary architecture and implementation queries. Explicit legacy queries like Agora, v2, legacy, or TKT-* still keep migrated context discoverable.

## Current source docs ingested
- MonstheraV3/README.md
- MonstheraV3/monsthera-architecture-v6-final.md
- MonstheraV3/monsthera-v3-implementation-plan-final.md
- MonstheraV3/monsthera-ticket-as-article-design.md
- docs/adrs/001-storage-model.md
- docs/adrs/002-work-article-model.md
- docs/adrs/003-migration-boundary.md
- docs/adrs/004-orchestration-model.md
- docs/adrs/005-surface-boundaries.md