---
id: k-7j6lirme
title: PR-18: semantic onboarding honesto — enable-semantic verificado cross-repo (Banyan P1)
slug: pr-18-semantic-onboarding-honesto-enable-semantic-verificado-cross-repo-banyan-p1
category: solution
tags: [banyan, semantic-search, embeddings, onboarding, consumer-driven]
codeRefs: [src/search/service.ts, src/cli/self-commands.ts, docs/consumer-setup.md, tests/unit/search/service.test.ts]
references: [k-3zo9w9dg, k-x4xfniba]
createdAt: 2026-06-10T10:23:59.132Z
updatedAt: 2026-06-10T10:23:59.132Z
---

Tercer fix consumer-driven Banyan. Rama `feat/banyan-p1-semantic`. El "semantic unavailable" de Banyan NO era una capacidad faltante: `self enable-semantic` (PR-12) ya hace todo — el root cause era operacional.

## Root cause preciso (vale recordarlo)

El índice de búsqueda es **in-memory por proceso**; los embeddings se generan al boot/index. El MCP server de Banyan arrancó con Ollama caído → 0 embeddings durante toda la vida del proceso, BM25-only, `semanticSearchEnabled:false` (que se computa honestamente como `enabled && embeddingCount > 0`, container.ts:582). Tras levantar Ollama hay que **reiniciar el server MCP** (o correr enable-semantic, que health-checkea primero, persiste `search.semanticEnabled=true` en `.monsthera/config.json` DEL repo target, y reindexa). `--repo` verificado end-to-end en self-commands.ts:51 — el repoPath resuelto se reenvía explícito a withContainer.

## Qué shippeó

1. Status accionable (TDD): `semantic unavailable — run: monsthera self enable-semantic (requires Ollama)` en getHealthStatus — una línea, sin llamadas de red.
2. consumer-setup.md: sección "Semantic search (optional, local-first)" con el comando único, verificación (status/doctor/eval engine) y la historia de degradación. **Bug de docs:** documentaba el env var inexistente `MONSTHERA_EMBEDDING_URL` — el real es `MONSTHERA_OLLAMA_URL`.
3. Gate-blocking heredado de P0-C arreglado: 3 fixtures digit-less en tests de integración (enmascarados por dist stale) + un id random `Math.random().toString(36)` que era digit-less ~7% de las veces → flaky pineado a `k-9reftarget`.

## Aceptación cross-repo — PARTIAL PASS honesto

En el clon (branch line-d): enable-semantic → 70 embeddings 768d, canary ok, status `semanticSearchEnabled: true`. Reproducción del estado-fallo de Banyan con el dist nuevo → el detail accionable aparece. Test de paráfrasis "how does pruning correctness avoid LP duality": **HB-038 #5 en search**; k-90-07 #9 y HB-040 #10 en ambas superficies. Análisis: (a) la premisa "sin keywords exactas" no se sostiene — HB-038 contiene "prune"/"valid"/"branching" y queries 4+ términos son OR, BM25 solo ya lo rankeaba #5; (b) la query contiene "LP duality" → los artículos dedicados a LP duality legítimamente dominan; un embedding no captura la negación "avoid LP duality". **Decisión: no tunear ranking para forzar el pass** — cambios de ranking pasan por el eval gate (regla del repo), y overfittear a una query es exactamente lo que el golden set existe para impedir.

## Verificación

typecheck 0 · eslint 0 · coverage EXIT 0 (lines 72.88 / branches 61.7 / functions 81.85) · **2280 passed** (+6) · corpus lint exit 0.