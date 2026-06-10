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
updatedAt: 2026-06-10T12:20:37.241Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T11:54:54.619Z"}]}
---

## Objective

Tres quick wins DX de la auditoría (k-3zo9w9dg, sección P3):

- **B1** — `ingest git` falta en el help top-level + clocks reales en tests flaky (hardening uptime, refs-stale medianoche UTC, insights-thresholds). Un PR.
- **B2** — ~69 tools MCP describen QUÉ hacen, no CUÁNDO usarlos → patrón "When to use: …". Solo descriptions. Un PR.
- **B3** — consolidar fetch+parse+timeout triplicado de Ollama → `src/core/ollama-client.ts`, cero cambio de comportamiento. Un PR.

## Acceptance Criteria

- B1: help muestra `ingest git`; 3 tests deterministas (frontera medianoche UTC pineada). ✅
- B2: 69/69 descriptions con When to use; schemas byte-idénticos (verificado por import+diff); suite verde. ✅
- B3: 5 suites de consumidores pasan sin tocar aserciones (57/57); duplicación eliminada. ✅
- Gate completo por PR + nota solution por PR. ✅

## Status 2026-06-10 — wave completa, PRs abiertos

- B1 → PR #154 (`fix/b1-ingest-help-flaky-clocks`), nota k-zydgbqeg. TDD red→green en help; 5/5 corridas estables.
- B2 → PR #155 (`chore/b2-tool-descriptions-when-to-use`), nota k-w9r21jkj. 2 agentes paralelos sobre archivos disjuntos + arnés de verificación por import real (schemas byte-idénticos, 69/69).
- B3 → PR #156 (`refactor/b3-ollama-client`), nota k-e86w9l9u. TDD 7-red→green; 1 diferencia deliberada divulgada (healthCheck embedding: throw → Result limpio en JSON inválido).
- **Eval gate de cierre: bm25 NDCG 0.8767 — IDÉNTICO al cierre de Wave A, regresión cero.** Semantic 0.098 (colapso pre-existente, diagnóstico en memoria de sesión para C1).

Pendiente para `done`: merge de #154/#155/#156 (stack tras #152/#153).