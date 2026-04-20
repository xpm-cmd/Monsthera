---
id: k-ey8wyfqz
title: Monsthera stale code ref repair and orchestration audit
slug: monsthera-stale-code-ref-repair-and-orchestration-audit
category: decision
tags: [monsthera-v3, orchestration, knowledge-hygiene]
codeRefs: [src/orchestration/service.ts, src/core/config.ts, src/search/service.ts, src/structure/service.ts, src/cli/doctor-commands.ts]
references: []
createdAt: 2026-04-10T12:38:12.842Z
updatedAt: 2026-04-10T12:38:12.842Z
---

## Summary
Dead-code cleanup removed the unused wiki bookkeeper constructor field and the unused SearchOptions import.

## Orchestration
Orchestration now consumes maxConcurrentAgents from config and executeWave runs with bounded parallelism instead of a fully sequential loop.

## Code reference hygiene
Code refs now normalize line anchors like #L10 and :10 before existence checks in search and structure analysis.

## Repair workflow
The doctor command can now scan stale code refs and prune them mechanically with --fix-stale-code-refs. This was used to remove stale Agora-era refs from migrated work and knowledge articles, reducing structure missingCodeRefCount to zero.