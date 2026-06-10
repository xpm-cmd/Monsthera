---
id: w-4vc60xph
title: Wave B: DX quick wins — help ingest git, clocks inyectados, when-to-use en tools, ollama-client compartido
template: refactor
phase: planning
priority: medium
author: claude-code
tags: [wave-b, dx]
references: [k-3zo9w9dg]
codeRefs: [src/cli/main.ts, tests/unit/hardening.test.ts, tests/unit/tools/refs-stale-tool.test.ts, tests/unit/context/insights-thresholds.test.ts, src/tools, src/search/embedding.ts, src/sessions/llm-summarizer.ts, src/core/text-generator.ts]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T11:54:54.619Z
updatedAt: 2026-06-10T11:54:54.619Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T11:54:54.619Z"}]}
---

## Objective

Tres quick wins DX de la auditoría (k-3zo9w9dg, sección P3):

- **B1** — `ingest git` falta en el help top-level (`src/cli/main.ts` bloque INGEST; el subcomando sí lo lista) + clocks reales en tests flaky: `hardening.test.ts` (~:188 setTimeout real), `refs-stale-tool.test.ts` (~:26 carrera a medianoche UTC), `insights-thresholds.test.ts` — fake timers / clock inyectado. Un PR.
- **B2** — los ~72 tools MCP (`src/tools/*.ts`) describen QUÉ hacen, no CUÁNDO usarlos → patrón "When to use: …" consistente. Solo descriptions, cero cambios de schema. Un PR.
- **B3** — consolidar el patrón fetch+parse+timeout triplicado de Ollama (`embedding.ts`, `llm-summarizer.ts`, `text-generator.ts`) → `src/core/ollama-client.ts`. Cero cambio de comportamiento: los tests de los tres pasan sin tocar aserciones. Un PR.

## Acceptance Criteria

- B1: help muestra `ingest git`; los 3 tests flaky pasan con tiempo congelado/avanzado determinista (incluida la frontera medianoche UTC).
- B2: cada tool description gana "When to use"; schemas byte-idénticos; suite verde.
- B3: tests de los tres consumidores pasan sin tocar aserciones; cero duplicación del patrón fetch+timeout.
- Gate completo por PR + 1 knowledge note solution por PR. Stack continúa sobre #153.