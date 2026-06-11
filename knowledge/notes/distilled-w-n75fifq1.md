---
id: k-d7m7jhus
title: Solution: H1 — Repository cache: matar el O(corpus-parse) por lookup en knowledge file-repository
slug: distilled-w-n75fifq1
category: solution
tags: [wave-h, performance, repository, cache, distilled]
codeRefs: [src/knowledge/file-repository.ts, src/work/file-repository.ts, src/knowledge/repository.ts]
references: [w-n75fifq1]
createdAt: 2026-06-11T12:22:44.902Z
updatedAt: 2026-06-11T12:22:44.902Z
origin: distilled
distilled_from: w-n75fifq1
---

> Distilled from work [w-n75fifq1] on completion. Origin: `distilled`.

## Objective

Todo lookup del knowledge file-repository re-parsea el corpus entero (`loadAll()` = readdir + readFile + parseMarkdown de cada `.md`) en cada `findById`/`findBySlug`/`findMany`/`findByCategory`/`findByTag`; `update()` lo hace ≥3 veces. A 147 artículos es tolerable; a 1K+ se arrastra. Introducir cache in-process con invalidación por stat (readdir + mtime/size por archivo, re-parse solo lo cambiado) sin romper la semántica multi-proceso (CLI y MCP server comparten archivos) ni las escrituras externas (corpora Option-A dropean archivos directo + `status()`).

## Acceptance Criteria

- (a) Corpus sintético ~1000 notas: timing antes/después de `knowledge get <id>` y context pack documentado en el PR (evidencia, NO test de CI).
- (b) Suite completa verde (typecheck 0, eslint 0, coverage exit 0, corpus lint exit 0).
- (c) Eval idéntico a 4 decimales vs `tests/eval/baseline.json` (refactor de read-path puro).
- (d) Smoke con el corpus real del repo.
- (e) Multi-proceso: stat-check por operación, no TTL ciego; escrituras externas detectadas; cero archivos fantasma en reads; invalidación tras writes propios.
- (f) Verificar si `src/work/file-repository.ts` comparte el patrón: cubrir si es barato, si no registrar follow-up con AC.
- (g) Evaluar disolver la dualidad de findBySlug (fast-path path-derivado vs frontmatter como única verdad) — decisión consciente + test + documentación; tests de fallback de G1 siguen verdes.

## Code
- `src/knowledge/file-repository.ts`
- `src/work/file-repository.ts`
- `src/knowledge/repository.ts`
