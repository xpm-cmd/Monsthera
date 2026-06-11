---
id: k-vvamtwke
title: Wave D1: responsive del sidebar, search results-first, y el badge fantasma de Convoys
slug: wave-d1-responsive-del-sidebar-search-results-first-y-el-badge-fantasma-de-convoys
category: solution
tags: [wave-d, dashboard, ux, responsive, css]
codeRefs: [public/styles.css, public/pages/search.js, public/lib/sidebar.js]
references: [k-gqkb0d2i, k-3zo9w9dg]
createdAt: 2026-06-10T22:56:54.107Z
updatedAt: 2026-06-10T22:56:54.107Z
---

Rama `feat/d1-dashboard-ux-prio1`, apilada sobre #160. Los tres hallazgos PRIO-1 del review visual, verificados con Claude Preview a 375/768/1280.

## (a) El sidebar móvil se tragaba el viewport — dos culpables en CSS

1. La media query de 900px forzaba `.sidebar-subnav { max-height: none }` — subnav de System **permanentemente abierto** en móvil (en desktop lo gobierna `.open`).
2. `.sidebar-nav li { flex: 1 1 150px }` en fila envuelta: el li de System (con subnav abierto adentro) estiraba su fila al alto del subnav, regando los sub-items con gaps gigantes.

Resultado: el primer viewport ENTERO era navegación; #content empezaba ~1600px abajo. Fix: el subnav conserva su comportamiento base colapsado/.open; nav compacta (gap 4px, padding 8×10, 14px); `li:has(.sidebar-subnav) { flex-basis: 100% }` para que al abrir empuje hacia abajo en vez de estirar a su vecino. **Medido después: sidebar 428px de 812px de viewport** — contenido above-the-fold en 375; 4 columnas limpias en 768; desktop intacto.

## (b) /search: resultados antes que didáctica con query activa

El ensamblaje renderizaba hero didáctico + summary del pack ANTES de los resultados (~600px de preámbulo). Ahora con `hasQuery`: resultados primero, summary después, hero omitido (queda como onboarding del estado vacío). Verificado a 1280: 3 result cards en el primer viewport.

## (d) El badge de Convoys: display explícito derrota a [hidden]

`.nav-badge { display: inline-flex }` — y un display explícito **le gana a la regla UA `[hidden] { display: none }`**: el badge renderizaba como círculo vacío permanente aunque el JS seteara `hidden=true`. Fix: `.nav-badge[hidden] { display: none; }` + tooltip `title` y `role="status"` junto al `aria-label` existente cuando hay warnings. (El finding original "sin aria" era parcialmente stale: aria-label ya existía.)

## Gotcha reusable

Cualquier elemento con `display` explícito en CSS necesita su propia regla `[hidden]` — el atributo HTML solo funciona vía la regla UA de menor especificidad. Patrón a auditar si aparecen más badges/elementos toggled por `hidden`.

## Verificación

Visual 375/768/1280 (screenshots en PR #161) + inspección DOM (sidebar 428px, item 37px) + orden estructural por eval (page-header → input → tabs → layout-split → summary; sin hero con query). Gate: typecheck 0 · eslint 0 · coverage exit 0 (2318) · corpus lint 0 · audit high 0.