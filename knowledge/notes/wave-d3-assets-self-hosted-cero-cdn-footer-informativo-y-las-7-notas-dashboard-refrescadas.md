---
id: k-zuks8lor
title: Wave D3: assets self-hosted (cero CDN), footer informativo, y las 7 notas dashboard-* refrescadas
slug: wave-d3-assets-self-hosted-cero-cdn-footer-informativo-y-las-7-notas-dashboard-refrescadas
category: solution
tags: [wave-d, dashboard, local-first, self-host, docs-refresh]
codeRefs: [public/index.html, public/vendor/fonts.css, public/pages/knowledge-graph.js, public/lib/sidebar.js]
references: [k-dqg0dmc3, k-3zo9w9dg]
createdAt: 2026-06-10T23:28:02.485Z
updatedAt: 2026-06-10T23:28:02.485Z
---

Rama `chore/d3-dashboard-polish`, apilada sobre #162. Cierra Wave D.

## (g) Política local-first de assets — cero requests externos

Lucide venía de unpkg, Cytoscape de unpkg (carga dinámica en el grafo), y 3 familias tipográficas de Google Fonts. Todo vive ahora en `public/vendor/` (~1MB: lucide.min.js, cytoscape.min.js, fonts.css + 15 woff2 de Manrope/Space Grotesk/Geist Mono — subsets variables bajados con UA moderno y URLs reescritas a locales). **Verificado en vivo: `performance.getEntriesByType("resource")` sin URLs no-origin en la app NI en la página de grafo**; fuentes cargadas localmente; `window.cytoscape` resuelve de /vendor.

El test "pinned lucide version" (que guardaba contra `@latest` flotante) se actualizó conscientemente: el self-hosting subsume esa preocupación — el invariante nuevo y más fuerte es "cero hostnames CDN en el HTML servido".

## Footer

`code · research · memory / workspace active` no decía nada → `Monsthera — local-first agent workspace / knowledge · work · sessions`.

## (h) Las 7 notas dashboard-* refrescadas (abril → hoy)

Delegado a agente con lista de deltas verificables + verificación propia del diff. Correcciones mayores: split del router D0 (composition root ~190 líneas + routes/*.ts), auth Bearer en TODOS los /api/* (la claim "GETs exentos" era falsa desde #143), CORS allowlist localhost (no wildcard), 11 nav items (el agente corrigió MI conteo de 12 contra el código), páginas nuevas (Events/Convoys/Code/Sessions), endpoints nuevos (/api/sessions, /api/system/eval, convoys, events, code-intel), heroes colapsables, vendor policy. El agente verificó cada claim contra el código antes de escribir — patrón que evitó perpetuar el conteo errado de mi propio prompt.

## Verificación

Corpus lint exit 0 tras los 7 updates · gate completo (typecheck 0 · eslint 0 · coverage exit 0 con 2322 · audit high 0) · verificación viva de cero-externos en 2 páginas.