---
id: k-f06au36t
title: Solution: Wave D: dashboard UX — split router, responsive, search results-first, heroes, Sessions, eval card, self-host
slug: distilled-w-y0wuvaix
category: solution
tags: [wave-d, dashboard, ux, distilled]
codeRefs: [src/dashboard/index.ts, public/styles.css, public/pages/search.js, public/lib/sidebar.js, public/app.js]
references: [w-y0wuvaix]
createdAt: 2026-06-11T00:14:45.261Z
updatedAt: 2026-06-11T00:14:45.261Z
origin: distilled
distilled_from: w-y0wuvaix
---

> Distilled from work [w-y0wuvaix] on completion. Origin: `distilled`.

## Objective

(Original en historial.) Hallazgos (a)-(h) del review visual 2026-06-10.

## Status 2026-06-10 — WAVE COMPLETA, PRs abiertos

- **D0** → PR #160 (`refactor/d0-dashboard-routes`), nota k-gqkb0d2i. Router 1433→189 líneas, 10 módulos routes/, 117/117 tests sin tocar.
- **D1** → PR #161 (`feat/d1-dashboard-ux-prio1`), nota k-vvamtwke. (a) sidebar móvil 428px/812px viewport (subnav forzado abierto era el culpable) · (b) results-first con query activa · (d) badge fantasma muerto (`[hidden]` vs display explícito) + tooltip. Verificación visual 375/768/1280.
- **D2** → PR #162 (`feat/d2-dashboard-features`), nota k-dqg0dmc3. (e) /sessions + GET /api/sessions(/:id) read-only, TDD 4-red→green · (f) /api/system/eval + card retrieval-quality (404 limpio en consumidores) · (c) heroes colapsables persistentes (collapseKey opt-in). Verificación DOM-level viva (12 sesiones reales; card con baseline C1 verbatim; collapse persiste reload).
- **D3** → PR #163 (`chore/d3-dashboard-polish`), nota k-zuks8lor. (g) cero CDN — vendor/ ~1MB, verificado vivo sin requests externos en app+grafo · footer informativo · (h) 7 notas dashboard-* refrescadas con claims code-verified (11 nav items).

**Eval gate de cierre:** P/R/MRR idénticos, NDCG +0.0013. Contamination 0.7273→0.8182 — artefacto de staleness del PROPIO golden set (las notas forbidden-por-desactualizadas fueron corregidas en D3 y vuelven a rankear): follow-up registrado w-j7ao5fak (re-revisar forbidden ids, eval-surgery).

Pendiente para `done`: merge de #160–#163 (stack tras #152–#159).

## Code
- `src/dashboard/index.ts`
- `public/styles.css`
- `public/pages/search.js`
- `public/lib/sidebar.js`
- `public/app.js`
