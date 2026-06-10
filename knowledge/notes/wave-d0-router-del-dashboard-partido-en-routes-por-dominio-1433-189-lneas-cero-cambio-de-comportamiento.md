---
id: k-gqkb0d2i
title: Wave D0: router del dashboard partido en routes/ por dominio — 1433 → 189 líneas, cero cambio de comportamiento
slug: wave-d0-router-del-dashboard-partido-en-routes-por-dominio-1433-189-lneas-cero-cambio-de-comportamiento
category: solution
tags: [wave-d, dashboard, refactor, file-split, routes]
codeRefs: [src/dashboard/index.ts, src/dashboard/routes/context.ts, src/dashboard/routes/work.ts, src/dashboard/routes/knowledge.ts]
references: [k-3zo9w9dg]
createdAt: 2026-06-10T12:55:50.891Z
updatedAt: 2026-06-10T12:55:50.891Z
---

Rama `refactor/d0-dashboard-routes`, apilada sobre #159. El archivo más grande del backlog de splits (auditoría P3): 18+ handlers, 33 secciones, 1433 líneas en un solo `handleRequest`.

## Diseño

- **`routes/context.ts`**: `RouteContext` mínimo de 5 campos ({req, res, url, pathname, container}) — los handlers derivan searchParams de ctx.url; no se infló el contexto.
- **Contrato por módulo**: `handle<Domain>Routes(ctx): Promise<boolean>` — true = manejó (y respondió); false = el chain sigue. Cada `return;` interno se volvió `return true;` mecánicamente.
- **10 módulos**: system (175) · orchestration (254) · code-intel (131) · ingest (32) · agents (51) · knowledge (199) · work (355) · search (120) · convoys (55) · context (16). index.ts queda en 189: lifecycle, CORS/OPTIONS, auth gate, pre-guard 405 cross-domain, chain ordenado, static, 404.
- **El orden del chain preserva el if-order original exacto** — convoys al FINAL (después de search), como en el monolito; los booleans de path (convoysListPath etc.) se mudaron a sus módulos; el pre-guard 405 que los referenciaba los inline-ea como comparaciones de pathname en index.ts.
- Helpers por dominio (`enrich*ForApi`) viajaron con su único consumidor; no hizo falta shared.ts.

## Ejecución

Delegado a agente background con receta exacta (mapa de secciones por número de línea + contrato + orden); verificación propia: lectura estructural del chain + spot-check verbatim de convoys.ts + gate completo.

## Verificación

Suite dashboard **117/117 con cero ediciones de tests** + las 5 suites consumidoras de startDashboard (82/82). Gate: typecheck 0 · eslint 0 · coverage exit 0 (2318 tests) · corpus lint 0 · audit high 0.

D1-D3 construyen sobre esta estructura (la card de eval/engine de D2 aterriza en routes/system.ts; la página Sessions necesitará un routes/sessions.ts).