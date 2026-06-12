---
id: w-arq1yroe
title: Snapshot capturedAt pierde el timezone en el round-trip Dolt — snapshots frescos nacen stale al este de UTC
template: bugfix
phase: done
priority: medium
author: claude-code
tags: [wave-h, follow-up, snapshot, dolt, timezone]
references: [solution-w-arq1yroe-dolt-timezone-roundtrip]
codeRefs: [src/work/guards.ts, scripts/capture-env-snapshot.ts, src/persistence/connection.ts, src/persistence/sql-datetime.ts, src/persistence/dolt-snapshot-repository.ts, src/persistence/dolt-orchestration-repository.ts, src/persistence/dolt-convoy-repository.ts, src/persistence/dolt-search-repository.ts, tests/smoke/dolt-real-smoke.test.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T13:04:26.093Z
updatedAt: 2026-06-12T07:45:57.966Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"claude-code","status":"contributed","contributedAt":"2026-06-12T07:29:02.665Z"}]}
reviewersJson: {"items":[{"agentId":"claude-code","status":"approved","reviewedAt":"2026-06-12T07:45:50.287Z"}]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T13:04:26.093Z","exitedAt":"2026-06-12T07:28:39.746Z"},{"phase":"enrichment","enteredAt":"2026-06-12T07:28:39.746Z","exitedAt":"2026-06-12T07:29:11.169Z","metadata":{"note":"Root cause confirmada con probes contra Dolt vivo: Dolt guarda dígitos UTC verbatim; mysql2 default timezone 'local' los relee como hora local en ambos protocolos. CURRENT_TIMESTAMP server-side produce dígitos locales (semánticas mezcladas)."}},{"phase":"implementation","enteredAt":"2026-06-12T07:29:11.169Z","exitedAt":"2026-06-12T07:45:35.319Z","metadata":{"success_test":"TDD: 6 smoke real-Dolt (MONSTHERA_DOLT_SMOKE=1, TZ=Australia/Sydney forzada) + 6 unit escritos primero y vistos fallar por el offset de 10h; verdes tras el fix. Gates: typecheck/lint/coverage (2404 passed) + bin.ts lint OK.","pr":"https://github.com/xpm-cmd/Monsthera/pull/183","fix":"timezone:'Z' en createDoltPool + toIsoTimestamp() en parse paths (snapshot/orchestration/convoy) + UTC_TIMESTAMP() en search_embeddings.updated_at"}},{"phase":"review","enteredAt":"2026-06-12T07:45:35.319Z","metadata":{"pr":"https://github.com/xpm-cmd/Monsthera/pull/183","ci":"typecheck · lint · test · corpus → SUCCESS","merged":"016b287 en main, 2026-06-12","live_verify":"record s-v6n8woql → get_latest capturedAt idéntico, ageSeconds 6, stale false (server reiniciado)"},"exitedAt":"2026-06-12T07:45:57.966Z"},{"phase":"done","enteredAt":"2026-06-12T07:45:57.966Z","metadata":{"merged":"PR #183 → main 016b287, 2026-06-12","live_verify":"post-restart: capturedAt idéntico al milisegundo, ageSeconds 6, stale false"}}]}
completedAt: 2026-06-12T07:45:57.966Z
---

## Objective

Encontrado en vivo durante H2 (2026-06-11, host en UTC+10): `record_environment_snapshot` responde `capturedAt: 2026-06-11T13:02:54.500Z` (UTC correcto), pero `get_latest_environment_snapshot` devuelve el MISMO snapshot con `capturedAt: 2026-06-11T03:02:54.500Z` — exactamente 10h menos (el offset local). Consecuencia: `ageSeconds: 36057` para un snapshot de 1 minuto → `stale: true` → el guard `snapshot_ready` (ADR-006) falla SIEMPRE en hosts al este de UTC, forzando skip_guard y degradando el gate a teatro.

Causa probable: el DATETIME de Dolt no lleva timezone; se escribe el instante UTC y al releer el driver lo interpreta como hora local (o viceversa) — clásico double-conversion en la capa de persistencia de snapshots.

## Acceptance Criteria

- Test que pinea el round-trip: record → getLatest devuelve `capturedAt` idéntico al de la respuesta del record (mismo instante, no ±offset local).
- `ageSeconds` de un snapshot recién grabado ≈ 0 en cualquier timezone del host (test con TZ forzada si es viable).
- El guard `snapshot_ready` pasa con un snapshot fresco y lockfiles coincidentes (smoke real del flujo ADR-006).
- Revisar si otros campos DATETIME del esquema Dolt (events, sessions) comparten el mismo round-trip roto — cubrir o registrar follow-ups por separado.

## Implementation

Mergeado en `main` (016b287) vía PR #183 (https://github.com/xpm-cmd/Monsthera/pull/183), TDD completo (6 smoke + 6 unit escritos primero, vistos fallar por el offset de 10h):

- `timezone: "Z"` en `createDoltPool` (`src/persistence/connection.ts`) — reads simétricos con los writes UTC; verificado en protocolo texto y binario contra Dolt vivo.
- `toIsoTimestamp()` nuevo en `src/persistence/sql-datetime.ts`, aplicado a los parse paths de snapshot/orchestration/convoy (mata el cast `timestamp(row.created_at)` que disfrazaba un `Date` de string).
- `UTC_TIMESTAMP()` en el upsert de `search_embeddings.updated_at` (era el único timestamp server-generated del flujo; `CURRENT_TIMESTAMP` producía dígitos locales).
- Regresión pineada en `tests/smoke/dolt-real-smoke.test.ts` con `TZ=Australia/Sydney` forzada: round-trip idéntico, `ageSeconds ≈ 0`, `snapshot_ready` pasa con lockfiles coincidentes.
- Auditoría AC #4: events y convoys cubiertos; **sessions no persisten en Dolt** (file/in-memory); los `DEFAULT CURRENT_TIMESTAMP` del DDL nunca disparan en el flujo de la app.

Verificación en vivo post-merge (MCP server reiniciado con el código nuevo): `record` s-v6n8woql → `get_latest` devuelve `capturedAt` **idéntico al milisegundo** (2026-06-12T07:43:57.322Z), `ageSeconds: 6`, `stale: false`.

Nota canónica: [[solution-w-arq1yroe-dolt-timezone-roundtrip]]