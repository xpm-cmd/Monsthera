---
id: k-k2ylcsm9
title: PR P0 shipped — audit hardening (auth GET, host bind, SDK bump, CI gates)
slug: pr-p0-shipped-audit-hardening-auth-get-host-bind-sdk-bump-ci-gates
category: solution
tags: [audit, security, ci, dashboard-auth, wave-1, post-m3]
codeRefs: [src/dashboard/auth.ts, src/core/config.ts, vitest.config.ts, .github/workflows/ci.yml, package.json, tests/unit/dashboard/auth.test.ts, tests/unit/core/config.test.ts]
references: [k-3zo9w9dg, w-kw9xy2i5]
createdAt: 2026-06-10T08:36:42.750Z
updatedAt: 2026-06-10T08:36:42.750Z
---

Wave 1 de la auditoría 2026-06-10 (ver [[auditora-integral-2026-06-10-backlog-priorizado-post-m3]], work w-kw9xy2i5). Rama `fix/p0-audit-hardening`. Orquestado con dynamic workflow (3 agentes paralelos en archivos disjuntos → bump serializado → gate de verificación).

## Qué shippeó

1. **Dashboard auth — GET ya no es exento** (`src/dashboard/auth.ts`): `AUTH_EXEMPT_METHODS` pasó de `{GET, OPTIONS}` a solo `{OPTIONS}` (preflight CORS no lleva header). Todo `/api/*` exige Bearer token salvo los path-exentos `/api/health` y `/api/status`. El SPA ya adjuntaba el token a todos los requests incl. GET (`public/lib/api.js`), así que la UI no se rompe. El fallback `req.method ?? "GET"` queda fail-closed.

2. **MONSTHERA_HOST validado** (`src/core/config.ts`): `superRefine` en `ServerConfigSchema` (no en `applyEnvOverrides`) — único chokepoint que cubre env override Y `config.json`. Host no-loopback (≠ localhost/127.0.0.1/::1/[::1]) lanza `ConfigurationError` salvo opt-in explícito `MONSTHERA_ALLOW_NONLOCAL_HOST=true`. La opt-in se lee de `process.env` dentro del refine (único tradeoff de pureza, contenido y comentado).

3. **SDK bump + overrides** (`package.json`): `@modelcontextprotocol/sdk` ^1.27.1→^1.29.0. El bump solo NO limpió los 3 highs (seguía resolviendo path-to-regexp@8.3.0 y fast-uri@3.1.0), así que se añadieron `pnpm.overrides` puntuales `path-to-regexp: >=8.4.0` y `fast-uri: >=3.1.2`. Resultado: 0 high (de 3), 18 moderate + 1 low restantes (todos transitivos vía hono/qs/ip-address del SDK, intencionalmente no overrideados — solo highs).

4. **CI gates muerden** (`.github/workflows/ci.yml`, `vitest.config.ts`): coverage dejó de ser `continue-on-error` (ahora gatea); umbrales bajados a floors reales tipo ratchet (lines 80→72, branches 70→61, functions 80); nuevo step `pnpm audit --prod --audit-level high` que gatea solo en highs de prod.

## Gotcha clave (lo atrapó el gate de verificación)

El fix de auth rompió **30 tests de integración del dashboard** (`dashboard.test.ts`, `snapshot-diff-route.test.ts`, `overview-flows.test.ts`) que hacían `fetch(url("/api/..."))` sin token → 401. NO es razón para revertir: el harness necesitaba autenticarse. Fix mecánico (29 GET funcionales + 1 cascada): añadir `authHeaders()`/Bearer inline, dejando intactos los GET a rutas exentas (`/api/status`), assets estáticos (`/`, `*.js`) y los tests que verifican el 401 por diseño. Lección: un cambio de política de auth tiene fallout en TODO harness de integración HTTP, no solo en el test unitario del módulo de auth — el scope acotado del agente de auth fue correcto (no pisó archivos ajenos), pero el orquestador debe prever el fallout cross-file.

## Verificación final (real)

typecheck 0 · eslint 0 · `pnpm coverage` EXIT 0 (lines 72.53 / branches 61.26 / functions 81.68, sobre los floors) · 2222 passed | 3 skipped | 0 failed · `tsx src/bin.ts lint` EXIT 0 · `pnpm audit --prod --audit-level high` EXIT 0.