---
id: k-dqg0dmc3
title: Wave D2: página Sessions, card de retrieval-quality, y heroes colapsables persistentes
slug: wave-d2-pgina-sessions-card-de-retrieval-quality-y-heroes-colapsables-persistentes
category: solution
tags: [wave-d, dashboard, sessions, eval-surface, ux]
codeRefs: [src/dashboard/routes/sessions.ts, src/dashboard/routes/system.ts, public/pages/sessions.js, public/lib/components.js, public/pages/system/health.js]
references: [k-vvamtwke, k-73ofos2z, k-3zo9w9dg]
createdAt: 2026-06-10T23:09:41.879Z
updatedAt: 2026-06-10T23:09:41.879Z
---

Rama `feat/d2-dashboard-features`, apilada sobre #161. Hallazgos (c)/(e)/(f) del review visual, construidos sobre la estructura routes/ de D0.

## (e) Sessions — la feature insignia de v3 por fin tiene superficie visual

`routes/sessions.ts`: GET `/api/sessions` (lista, más recientes primero) y `/api/sessions/:id`, **read-only** (el lifecycle se queda en CLI/MCP — la página enseña los comandos en su hero). Página `/sessions`: lista con status/agente/branch/ventana/intent + panel de detalle (handoff article id, quality, abandon reason) + item de nav. TDD 4-red→green a nivel ruta (list, detail, 404, 405 — patrón startDashboard real con Bearer).

## (f) Card de retrieval-quality en System Health

GET `/api/system/eval` sirve el `tests/eval/baseline.json` commiteado + config semántica viva. **En repos consumidores sin el archivo → 404 limpio y la card se oculta** (diseño consumer-aware). La card muestra: engine del baseline, estado semántico vivo, casos del golden set, NDCG/MRR/recall/contamination — la superficie visual del trabajo de C1.

## (c) Heroes didácticos colapsables con persistencia

`renderHeroCallout` gana `collapseKey` opt-in: primers de flow/knowledge/work/search + sessions lo usan; el next-best-action dinámico de Overview deliberadamente NO. Persistencia `monsthera-hero-<key>` en localStorage (patrón monsthera-theme); UN handler delegado a nivel document en app.js (sin re-render: toggle de clase + estado re-aplicado al render).

## Gotcha de verificación con preview

Tras reiniciar el server, el tab conserva el bundle JS viejo — `pushState` no refetchea: el primer click del toggle corrió contra app.js antiguo y "no funcionó". Reload explícito antes de verificar JS nuevo. (Y el compositor de screenshots puede devolver negro tras ciclos rápidos stop/start/reload — la verificación DOM-level via eval es más confiable para features estructurales.)

## Verificación

Vivo (DOM): /sessions con 12 sesiones reales · card con engine semantic / NDCG 0.899 / 28 casos (el baseline de C1 verbatim) · collapse persiste tras reload completo (clase + localStorage + display:none computado). Gate: typecheck 0 · eslint 0 · coverage exit 0 (2322, +4) · corpus lint 0 · audit high 0.