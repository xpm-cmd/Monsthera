---
id: k-l6o5ujfw
title: Wave A2: GUARD_FAILED min_enrichment_met ahora nombra roles pendientes y remedios
slug: wave-a2-guard-failed-min-enrichment-met-ahora-nombra-roles-pendientes-y-remedios
category: solution
tags: [wave-a, consumer-driven, work-tracking, guards, dx]
codeRefs: [src/work/guards.ts, src/work/lifecycle.ts, tests/unit/work/lifecycle.test.ts]
references: [k-e9atys0k, k-3zo9w9dg]
createdAt: 2026-06-10T11:49:17.470Z
updatedAt: 2026-06-10T11:49:17.470Z
---

Cierra la fricción #1 del quickstart de work tracking (k-e9atys0k): `GUARD_FAILED: min_enrichment_met` no nombraba roles pendientes ni remedio. Rama `fix/a2-guard-failed-actionable` (apilada sobre A1).

## Diseño

- **`GuardEntry.recoveryHint?: (article) => string`** — contraparte sync del `AsyncGuardEntry.recoveryHint` existente (patrón snapshot_ready), pero función del artículo porque el hint útil necesita estado (roles pendientes concretos). Los guards sin hint conservan el mensaje plano (test de regresión lo pinea).
- **`minEnrichmentRecoveryHint(article, min)`** en guards.ts (puro, testeable): reporta progreso `n/min`, enumera `pending: <roles>`, y deletrea ambos remedios con el id real: `work enrich <id> --role <role> --status contributed|skipped` (MCP: `contribute_enrichment`) o `--skip-guard-reason "<why>"` (MCP: `skip_guard`).
- `checkTransition` concatena el hint al `GuardFailedError.message` → un solo punto cubre CLI (`formatError` passthrough), MCP y dashboard. stderr sigue siendo el canal (convención intacta).

## Mensaje resultante (verbatim del smoke CLI)

`Error [GUARD_FAILED]: Guard "min_enrichment_met" failed: Guard "min_enrichment_met" failed for transition from "enrichment" to "implementation". 0/1 enrichment role(s) contributed or skipped; pending: architecture, testing. Remedy: work enrich w-cqodi4xi --role <role> --status contributed|skipped per pending role (MCP: contribute_enrichment), or re-run the advance with --skip-guard-reason "<why>" (MCP: skip_guard) to bypass with an audit trail.`

(El doble prefijo `Guard "x" failed:` es preexistente de `GuardFailedError` — cosmético, fuera de alcance.)

## Verificación

TDD 4-red→green: unit del hint (roles pendientes + rama sin-pendientes), integración checkTransition, y passthrough a nivel service (el string exacto que imprime el CLI). Work suite 402/402 · gate completo verde (typecheck 0 · eslint 0 · coverage exit 0 con 2304 tests · corpus lint 0 · audit high 0) · smoke CLI real en repo scratch.