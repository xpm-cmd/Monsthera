---
id: k-3zo9w9dg
title: Auditoría integral 2026-06-10 — backlog priorizado post-M3
slug: auditora-integral-2026-06-10-backlog-priorizado-post-m3
category: context
tags: [audit, roadmap, prioritization, post-m3, security, eval, corpus-hygiene]
codeRefs: [.github/workflows/ci.yml, README.md, src/dashboard/auth.ts, src/core/config.ts, tests/eval/golden/knowledge.json, src/dashboard/index.ts, src/work/lint.ts, src/core/container.ts, package.json]
references: []
createdAt: 2026-06-10T08:04:21.132Z
updatedAt: 2026-06-10T08:04:21.132Z
---

Auditoría completa sobre main @ caa6166 (post-M3, v3.0.0). Método: verificaciones mecánicas (typecheck/lint/test/coverage/audit/eval) + 4 agentes Explore paralelos (arquitectura, seguridad, tests, DX/producto) + reconciliación de deferred items y salud del corpus. Hallazgos clave verificados a mano antes de registrarse.

## Estado base (verificado)

- 2210 tests verdes (3 skipped), typecheck 0, eslint 0, suite ~30s.
- `pnpm coverage` FALLA en main: lines 72.51% < 80, branches 61.17% < 70. CI lo corre con `continue-on-error: true` (report-only, documentado en ci.yml) — sin ratchet, nada impide retroceso.
- `pnpm audit`: 23 vulnerabilidades (3 high, 19 moderate, 1 low), TODAS transitivas vía `@modelcontextprotocol/sdk@1.27.1` (hono, express/path-to-regexp, fast-uri, qs, ip-address). 1.29.0 disponible. Exposición runtime baja (Monsthera usa stdio + http propio, no los transports HTTP del SDK), pero es ruido de auditoría y deuda de higiene.
- Eval harness saturado: 7 casos × 1 esperado × k=5 → P@5 clavado en 0.2, NDCG/MRR en 1.0. No puede medir ni regresiones ni mejoras de ranking.
- Durante el eval, Ollama estaba caído: TODAS las queries cayeron a BM25 con warn, pero el reporte dice `semanticEnabled: true` y aún así dio métricas perfectas. Dos bugs de honestidad: (a) status/eval no distinguen "semantic configurado" de "semantic operativo"; (b) corridas de eval no son comparables si no registran qué motor respondió cada query.

## Hallazgos P0 (integridad/seguridad, esfuerzo S)

1. README sección Status dice "v3.0.0-alpha.4 — Clean rewrite in progress" y "dispatch and convoy features … not yet implemented" — ambos falsos (convoys shippeados desde S4/abril; versión estable 3.0.0). El doc-sync de PR #142 no tocó esa sección. También linkea la visión v6 como "Architecture Docs".
2. Dashboard auth: `AUTH_EXEMPT_METHODS = {GET, OPTIONS}` (src/dashboard/auth.ts:8) → TODO GET de /api/* lee corpus/work/eventos sin token. Combinado con `MONSTHERA_HOST` sin validación (config.ts:156, `z.string()` plano que acepta 0.0.0.0), un bind mal configurado expone lectura total en red. Fix: exigir token en todos los /api salvo health/status + validar host localhost-only o warn explícito.
3. Bump @modelcontextprotocol/sdk → 1.29.0 (+ minors mysql2/zod/shikijs) y añadir gate `pnpm audit --prod --audit-level high` al CI.
4. Coverage ratchet: bajar thresholds a la realidad (lines 72, branches 61), quitar continue-on-error, subir gradualmente. Hoy el umbral 80/70 es aspiracional y no protege nada.

## Hallazgo keystone (P1): expandir el golden set del eval

Los tres deferred items (salience implement-or-drop, cf search-term emission, reranker tuning) están bloqueados por el mismo cuello de botella: el eval saturado no puede demostrar que un cambio de ranking ayude. Expandir a 20-30 casos con queries multi-relevantes (3-5 esperados), casos negativos y k=10 desbloquea todo el track de calidad de recuperación. Hacer ANTES de cualquier cambio de ranking.

## P1 restantes

- Honestidad semántica: registrar engine real por query en eval; `semanticDegraded` en status; check de Ollama vivo en doctor (hoy doctor no chequea sistema: ni Node version, ni binario Dolt, ni Ollama, ni drift de versión global-vs-repo — el incidente alpha.7 sigue sin guard).
- Dolt persistence: 4 repos Dolt testeados SOLO con mysql2 mockeado (coverage real 42%); ni schema ni transacciones se ejercitan jamás. Un smoke test contra Dolt real (local/pre-release, no necesariamente CI).
- CLI coverage: policy/doctor/events/hook/lint/prompt/self-commands entre 0.9% y 18% — son superficie de usuario sin red de seguridad.

## P2 — corpus y grafo

- Solo 6/21 ADRs importados como knowledge (001-005 + 015). Importar los 15 restantes arregla ~13 de las 24 orphan citations y enriquece el grafo. `ingest local` ya lo soporta.
- Lint orphan_citation produce falsos positivos estructurales: URLs (refs externas legítimas, p.ej. GitNexus) e IDs de ejemplo en docs (`w-abc`, `k-abc123`) contados como citas rotas. Clasificar URLs como referencia externa; exentar ejemplos (code-fence awareness o tag lint-exempt).
- Staleness: 63/114 artículos sobre la ventana de 45 días — ventana única para todo genera ruido (un ADR no caduca como un handoff). Ventanas por categoría o mecanismo `verified_at` (re-verificar sin editar).
- ADR-014 duplicado: 014-convoy-dashboard.md Y 014-portable-workspace-operations.md, ambos Accepted. Renumerar uno.
- Borrar docs/handoff-monsthera-product-feedback.md (untracked): describe T1-T11 ya shippeados (PRs #118-121), ancla en 1e9ba53, totalmente superado.

## P3 — arquitectura y DX (salud 6/10 según agente: sin ciclos, Result<T,E> consistente, pero 22 archivos sobre el cap de 500 líneas)

- Splits mecánicos en orden de ROI: dashboard/index.ts (1433, 18 handlers en un handleRequest → routes/), work/lint.ts (871 → rules/ por finding type), container.ts (681 → factories por subsistema), search/service.ts y structure/service.ts (precedente: think-synthesis.ts).
- Consolidar cliente LLM: el patrón fetch+parse+timeout de Ollama está triplicado (embedding, llm-summarizer, text-generator) → ollama-client compartido.
- Dashboard sin página de sessions (feature insignia de v3 sin superficie visual); `ingest git` falta en el help top-level (subcomando sí lo lista).
- Tool descriptions MCP: añadir patrón "when to use" a los ~72 tools.
- Flaky-risk en tests: Date.now()/setTimeout reales en hardening.test.ts, refs-stale-tool.test.ts (carrera a medianoche UTC) → inyectar clock.

## Deferred reconciliados

- Salience (PR-13b): NO hay código en src (se difirió antes de implementar) — la decisión es implementar-o-descartar, no keep-revert, y depende del eval expandido.
- cf search-term emission: confirmado ausente (cero menciones de extraFrontmatter en src/search). `--filter custom.<k><op><v>` funciona; search no ve los valores.
- PR-15 per-commit codeRefs: sigue diferido, prioridad baja.