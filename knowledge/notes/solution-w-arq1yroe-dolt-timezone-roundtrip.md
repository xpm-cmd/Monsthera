---
name: solution-w-arq1yroe-dolt-timezone-roundtrip
description: "Snapshots frescos nacían 10h stale al este de UTC: Dolt guarda dígitos UTC verbatim y mysql2 (timezone 'local' por defecto) los releía como hora local. Fix: timezone 'Z' en el pool + toIsoTimestamp + UTC_TIMESTAMP()."
category: solution
tags: [dolt, timezone, snapshot, mysql2, persistence, wave-h]
codeRefs:
  - src/persistence/connection.ts
  - src/persistence/sql-datetime.ts
  - src/persistence/dolt-snapshot-repository.ts
  - src/persistence/dolt-orchestration-repository.ts
  - src/persistence/dolt-convoy-repository.ts
  - src/persistence/dolt-search-repository.ts
  - tests/smoke/dolt-real-smoke.test.ts
references: []
---

## Síntoma (w-arq1yroe, encontrado en vivo 2026-06-11)

`record_environment_snapshot` respondía `capturedAt` UTC correcto, pero
`get_latest_environment_snapshot` devolvía el MISMO snapshot 10h antes (host
AEST/UTC+10). `ageSeconds ≈ 36000` para un snapshot de 1 minuto → `stale: true`
→ el guard `snapshot_ready` (ADR-006) fallaba SIEMPRE al este de UTC.

## Causa raíz (verificada empíricamente contra Dolt vivo)

Double-conversion asimétrica en la frontera driver↔servidor:

1. **Write**: `timestamp()` produce un ISO string UTC (`…T13:02:54.500Z`).
   Dolt (session `time_zone = SYSTEM`, AEST) guarda **los dígitos UTC
   verbatim** — no aplica conversión de sesión al literal, ni siquiera con la
   `Z` explícita. `CAST(col AS CHAR)` confirmó dígitos `13:02:54.5`.
2. **Read**: mysql2 sin config `timezone` usa `'local'` y parsea los dígitos
   `13:02:54` como hora Sydney → `03:02:54Z`. Mismo comportamiento en protocolo
   de texto (`pool.query`) y binario (`pool.execute`, el que usan los repos).

Hallazgo adicional: `CURRENT_TIMESTAMP` server-side produce dígitos **locales**
(AEST), así que la base mezclaba semánticas de dígitos entre writes de la app
(UTC) y defaults del servidor (local).

## Fix (tres capas, mismo root cause)

1. **`timezone: "Z"` en `createDoltPool`** — el driver interpreta y serializa
   los dígitos como UTC. Es EL fix: round-trip bit a bit verificado.
2. **`toIsoTimestamp()` (`src/persistence/sql-datetime.ts`)** en los parse
   paths de snapshot/orchestration/convoy — normaliza `Date` del driver y
   strings de dígitos MySQL a ISO-Z, y elimina el cast mentiroso
   `timestamp(row.created_at)` que disfrazaba un `Date` de string.
3. **`UTC_TIMESTAMP()` en vez de `CURRENT_TIMESTAMP`** en el upsert de
   `search_embeddings.updated_at` — único punto del flujo de la app que
   generaba timestamps server-side; ahora todos los dígitos almacenados son
   UTC uniformes.

## Auditoría de los demás DATETIME/TIMESTAMP del esquema (AC #4)

- `orchestration_events.created_at` — mismo bug; cubierto por fix + smoke.
- `convoys.created_at/completed_at` — mismo cast mentiroso; cubierto.
- `search_documents.indexed_at` — write explícito UTC ISO; corregido en lectura
  por el fix del pool.
- `search_embeddings.updated_at` — era el único `CURRENT_TIMESTAMP` del flujo;
  migrado a `UTC_TIMESTAMP()` + smoke.
- **Sessions NO persisten en Dolt** (file-repository/in-memory) — sin bug.
- Los `DEFAULT CURRENT_TIMESTAMP` del DDL nunca disparan en el flujo (todos
  los INSERT pasan valores explícitos), pero filas insertadas a mano vía
  `dolt sql` llevarían dígitos locales — gotcha a tener presente.

## Regresión pineada

`tests/smoke/dolt-real-smoke.test.ts` fuerza `TZ=Australia/Sydney` a nivel de
proceso (los tests de igualdad de instante serían tautológicos en CI UTC) y
pinea: round-trip `capturedAt` idéntico, `ageSeconds ≈ 0`, `snapshot_ready`
pasa con lockfiles coincidentes, `createdAt` de eventos como string y mismo
instante (tolerancia 2s por TIMESTAMP(0)), y dígitos UTC en
`search_embeddings.updated_at`. Unit tests pinean la config del pool y las
tres coerciones de parse.

## Gotcha transferible

Cualquier columna DATETIME/TIMESTAMP leída vía mysql2 sin `timezone` explícito
es una bomba de timezone latente: el default `'local'` hace que el resultado
dependa del TZ del host. Regla: decidir la semántica de dígitos (UTC) y fijarla
en AMBOS extremos — pool (`timezone: "Z"`) y generación server-side
(`UTC_TIMESTAMP()`), nunca `CURRENT_TIMESTAMP`.
