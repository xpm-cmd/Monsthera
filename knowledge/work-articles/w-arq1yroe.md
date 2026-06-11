---
id: w-arq1yroe
title: Snapshot capturedAt pierde el timezone en el round-trip Dolt — snapshots frescos nacen stale al este de UTC
template: bugfix
phase: planning
priority: medium
author: claude-code
tags: [wave-h, follow-up, snapshot, dolt, timezone]
references: []
codeRefs: [src/work/guards.ts, scripts/capture-env-snapshot.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-11T13:04:26.093Z
updatedAt: 2026-06-11T13:04:26.093Z
enrichmentRolesJson: {"items":[{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-11T13:04:26.093Z"}]}
---

## Objective

Encontrado en vivo durante H2 (2026-06-11, host en UTC+10): `record_environment_snapshot` responde `capturedAt: 2026-06-11T13:02:54.500Z` (UTC correcto), pero `get_latest_environment_snapshot` devuelve el MISMO snapshot con `capturedAt: 2026-06-11T03:02:54.500Z` — exactamente 10h menos (el offset local). Consecuencia: `ageSeconds: 36057` para un snapshot de 1 minuto → `stale: true` → el guard `snapshot_ready` (ADR-006) falla SIEMPRE en hosts al este de UTC, forzando skip_guard y degradando el gate a teatro.

Causa probable: el DATETIME de Dolt no lleva timezone; se escribe el instante UTC y al releer el driver lo interpreta como hora local (o viceversa) — clásico double-conversion en la capa de persistencia de snapshots.

## Acceptance Criteria

- Test que pinea el round-trip: record → getLatest devuelve `capturedAt` idéntico al de la respuesta del record (mismo instante, no ±offset local).
- `ageSeconds` de un snapshot recién grabado ≈ 0 en cualquier timezone del host (test con TZ forzada si es viable).
- El guard `snapshot_ready` pasa con un snapshot fresco y lockfiles coincidentes (smoke real del flujo ADR-006).
- Revisar si otros campos DATETIME del esquema Dolt (events, sessions) comparten el mismo round-trip roto — cubrir o registrar follow-ups por separado.