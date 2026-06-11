---
id: k-zydgbqeg
title: Wave B1: ingest git visible en help top-level + relojes deterministas en tests time-sensitive
slug: wave-b1-ingest-git-visible-en-help-top-level-relojes-deterministas-en-tests-time-sensitive
category: solution
tags: [wave-b, dx, cli-help, flaky-tests, fake-timers]
codeRefs: [src/cli/main.ts, tests/unit/hardening.test.ts, tests/unit/tools/refs-stale-tool.test.ts, tests/unit/context/insights-thresholds.test.ts]
references: [k-3zo9w9dg]
createdAt: 2026-06-10T11:59:36.992Z
updatedAt: 2026-06-10T11:59:36.992Z
---

Wave B1 (auditoría P3). Rama `fix/b1-ingest-help-flaky-clocks`, apilada sobre #153.

## Help

El bloque INGEST de `monsthera --help` solo listaba `ingest local`; `ingest git` existía (PR-15 de M3) pero era indescubrible desde el top level. TDD: aserción red en main.test.ts (`/ingest git\s+--range/`) → línea de subcomando + ejemplo en el bloque EXAMPLES.

## Relojes deterministas (3 tests)

1. **hardening.test.ts uptime** — `setTimeout(10)` real contra resolución de timers: con carga de CPU el sleep puede redondear a 0ms de delta. Fake timers + `advanceTimersByTime(10)` y la aserción sube de `toBeGreaterThan` a **delta exacto `+10`** (más fuerte que la original).
2. **refs-stale-tool.test.ts / insights-thresholds.test.ts** — `daysAgo(n)` derivado de `Date.now()` real mientras el servicio lee SU `Date.now()` después: los umbrales día-granulares (`ageDaysFrom` floor) pueden flipear si una medianoche UTC cruza entre fixture y aserción. **Reloj congelado exactamente en medianoche UTC** (`2026-06-10T00:00:00.000Z`) vía `vi.setSystemTime` file-wide — la frontera peligrosa queda pineada como caso de prueba permanente.

## Patrón para el futuro

Cualquier test que construya fixtures con `Date.now()` relativo Y ejercite código que vuelva a leer `Date.now()` debe congelar el reloj (beforeEach useFakeTimers+setSystemTime / afterEach useRealTimers). El "safe harbor" de medio día NO es suficiente con umbrales floor() día-granulares.

## Verificación

5/5 corridas consecutivas estables de los 3 archivos · gate completo verde (typecheck 0 · eslint 0 · coverage exit 0 con 2305 tests · corpus lint 0 · audit high 0).