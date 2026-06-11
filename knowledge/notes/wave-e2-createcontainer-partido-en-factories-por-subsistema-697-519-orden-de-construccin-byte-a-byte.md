---
id: k-bhj6atny
title: Wave E2: createContainer partido en factories por subsistema — 697 → 519, orden de construcción byte-a-byte
slug: wave-e2-createcontainer-partido-en-factories-por-subsistema-697-519-orden-de-construccin-byte-a-byte
category: solution
tags: [wave-e, refactor, file-split, container, factories]
codeRefs: [src/core/container.ts, src/core/factories/dolt-initializer.ts, src/core/factories/search-provider-factory.ts, src/core/factories/llm-factory.ts]
references: [k-talge4d2, k-3zo9w9dg]
createdAt: 2026-06-11T00:30:55.540Z
updatedAt: 2026-06-11T00:30:55.540Z
---

Rama `refactor/e2-container-factories` desde main post-#165. Tercer split del backlog (preced.: D0 routes/, E1 rules/).

## Diseño

`container.ts` 697→519 (orquestación): `MonstheraContainer`, `createContainer` llamando factories, `createTestContainer`. Tres factories en `src/core/factories/`:

- **dolt-initializer (200)** — `DoltUnavailableError` + TODO el bloque de storage: pool, schema init, los 4 repos Dolt, health monitor + registro en status, y el fallback degradado in-memory con sus mensajes warn/info EXACTOS (los tests de hardening los pinean). Devuelve los repos tipados `| undefined` espejando los `let` originales → las aserciones non-null downstream quedaron carácter-idénticas.
- **search-provider-factory (46)** — embedding provider (Ollama vs Stub con su info log) + reranker.
- **llm-factory (53)** — text generator (Ollama/OpenAI-compat/Stub) + summarizer de sesiones.

## Juicios behavior-neutral (el resto verbatim)

- `shouldAllowDegraded` privado en container.ts, pasado como **thunk** — la env var se sigue leyendo lazy en los puntos exactos de fallo.
- El `DisposableStack` se pasa al factory → los defers `closePool`/`stopMonitor` conservan su posición LIFO original relativa a los demás.
- Orden de construcción byte-a-byte: FS repos → storage → embedding → code inventory ANTES de SearchService → services → summarizer → textGenerator → setReranker → resync.
- `DoltUnavailableError` re-exportado (`arg-helpers.ts` y tests lo importan de container.js) — cero importers tocados.

## Verificación

327 tests core/hardening/dashboard sin tocar · gate completo (typecheck 0 · eslint 0 · coverage exit 0 con 2322 · corpus lint 0 · audit high 0).