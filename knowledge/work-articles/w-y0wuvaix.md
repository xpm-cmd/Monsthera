---
id: w-y0wuvaix
title: Wave D: dashboard UX — split router, responsive, search results-first, heroes, Sessions, eval card, self-host
template: feature
phase: planning
priority: medium
author: claude-code
tags: [wave-d, dashboard, ux]
references: [k-3zo9w9dg]
codeRefs: [src/dashboard/index.ts, public/styles.css, public/pages/search.js, public/lib/sidebar.js, public/app.js]
dependencies: []
blockedBy: []
createdAt: 2026-06-10T12:42:29.465Z
updatedAt: 2026-06-10T12:42:29.465Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"claude-code","status":"pending"},{"role":"testing","agentId":"claude-code","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-06-10T12:42:29.465Z"}]}
---

## Objective

Hallazgos verificados con el dashboard corriendo (2026-06-10, review visual "Wave 6"): (a) responsive roto <~800px (sidebar colapsa a grilla horizontal y #content desaparece); (b) /search con resultados ~600px bajo el guide; (c) heroes didácticos enormes sin colapso persistente; (d) nav-badge Convoys sin tooltip/aria; (e) sin página Sessions; (f) sin superficie eval/engine en System; (g) deps CDN contra el ethos local-first; (h) las 5 notas dashboard-* (abril) desactualizadas.

- **D0** — split mecánico de `src/dashboard/index.ts` (~1433 líneas, 18 handlers en un handleRequest) → `src/dashboard/routes/*.ts` por dominio. Cero cambio de comportamiento; tests existentes como arnés.
- **D1** — PRIO 1 UX: responsive (a) + search results-first (b) + badge tooltip (d). Verificación visual con Claude Preview a 1280/768/375.
- **D2** — features: heroes colapsables con persistencia localStorage (c) + página Sessions (e) + card eval/engine en System (f).
- **D3** — polish: self-host assets (g) + footer críptico + refresh de notas dashboard-* (h, via update_article).

## Acceptance Criteria

- D0: suite dashboard verde sin tocar aserciones; index.ts reducido a wiring; un PR.
- D1: screenshots 1280/768/375 con sidebar utilizable y #content visible; resultados de búsqueda above-the-fold con query activa; tooltip+aria en badge. Un PR.
- D2: heroes colapsan y persisten (patrón monsthera-theme); /sessions lista sesiones reales (backend si falta); card System muestra engine + métricas del baseline. Un PR.
- D3: cero requests a CDN externos; notas dashboard-* actualizadas. Un PR.
- Gate completo por PR + nota solution por PR; eval sin regresión al cierre.