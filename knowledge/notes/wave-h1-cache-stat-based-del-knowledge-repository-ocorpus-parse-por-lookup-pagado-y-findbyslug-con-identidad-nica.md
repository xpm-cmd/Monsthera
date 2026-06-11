---
id: k-y8xvwfu7
title: Wave H1: cache stat-based del knowledge repository — O(corpus-parse) por lookup pagado y findBySlug con identidad única
slug: wave-h1-cache-stat-based-del-knowledge-repository-ocorpus-parse-por-lookup-pagado-y-findbyslug-con-identidad-nica
category: solution
tags: [wave-h, performance, file-repository, cache, read-path]
codeRefs: [src/core/stat-cache.ts, src/knowledge/file-repository.ts, tests/unit/core/stat-cache.test.ts, tests/unit/knowledge/file-repository-cache.test.ts, tests/unit/knowledge/file-repository-slug-identity.test.ts]
references: [w-n75fifq1, w-7nnee3c2, k-p90ik5jo, k-73ofos2z]
createdAt: 2026-06-11T12:19:30.233Z
updatedAt: 2026-06-11T12:19:30.233Z
---

Cierra w-n75fifq1. Rama `perf/h1-repository-cache`.

## El problema

Todo lookup del knowledge file-repository re-parseaba el corpus entero: `loadAll()` = readdir + readFile + parseMarkdown de CADA `.md`, llamado desde 9 métodos públicos; `update()` lo hacía ≥3 veces (findById fuera del lock, otra vez dentro, loadAll para unicidad de slug). A 147 artículos tolerable; a 1K+ un acantilado — el comentario de `findUpdatedSince` ya reconocía la deuda.

## El diseño: `StatCachedDirectoryReader<T>` (src/core/stat-cache.ts, genérico)

- **Stat sweep por operación, no TTL ciego**: readdir + `fs.stat` por archivo; re-parse solo de entradas cuyo `(mtimeMs, ctimeMs, size, ino)` cambió. Multi-proceso seguro POR CONSTRUCCIÓN: el CLI junto al MCP server, y los corpora Option-A que dropean archivos directo en `notes/`, se detectan por el stat-check mismo.
- **Ventana racy estilo racy-git (default 2000ms)**: una entrada cacheada mientras su mtime estaba dentro de la ventana se distrusta y re-parsea — una reescritura dentro del mismo gránulo de timestamp es invisible para la comparación stat. `ctimeMs + ino` atrapan además reemplazo de archivo (`git checkout`) y escritores que preservan mtime (`cp -p`): ctime no se puede falsificar desde userspace. `racyWindowMs: 0` desactiva el guard (los tests de conteo necesitan determinismo; Date.now() entero-ms vs mtime float-ms del mismo ms sería flaky).
- **Writes propios invalidan explícito** (writeArticle, minimal-diff patch, delete; rename invalida ambos paths). En errores de escritura no-EEXIST también se invalida (el write pudo aterrizar parcial).
- **Errores jamás se cachean**: archivo corrupto aborta el load igual que antes; repararlo se observa al siguiente read.
- **Copias defensivas de un nivel** al salir (objeto + tags/codeRefs/references/extraFrontmatter): el contrato pre-cache era "objetos frescos por read". Recon sobre TODOS los consumidores (workflow 4 agentes): cero mutaciones in-place hoy — la copia es seguro, no fix.
- **Cero fantasmas**: poda por sweep, scoped al dir leído (entradas del fallback worktree sobreviven sweeps del primary).

## Decisión: dualidad de findBySlug disuelta

El fast-path path-derivado (`notes/<slug>.md` directo) existía porque el scan era caro. Con scans cacheados su único efecto restante era una fuga semántica: un archivo cuyo NOMBRE diverge de su frontmatter `slug:` resolvía bajo dos identidades. Ahora frontmatter slug = única identidad de read-path (termina lo que G1 empezó). **El edge que cambia**: lookup por filename-stem de un archivo divergente → NotFound (pinneado en `file-repository-slug-identity.test.ts`). Recon de callers: orphan-citation/stem-resolution y graph building usan mecanismos propios — no afectados; corpus real: 0 archivos divergentes. Bonus de consistencia: el collision-check de create (service→findBySlug) ahora ve el mismo universo de slugs que `existingSlugs` del repo.

## Evidencia (corpus sintético 1000 notas, mtimes envejecidos = steady state)

| operación | old | new |
|---|---|---|
| cold findMany (1er op del proceso) | 83.2ms | 98.3ms (+18%: un stat extra + clones, una vez) |
| warm findById avg ×50 | 67.3ms | **12.4ms (5.4×)** |
| update (3 loadAll → 1 parse + 2 sweeps) | 134.5ms | **27.4ms (4.9×)** |
| warm findBySlug | 0.23ms | 11.7ms (costo consciente de la disolución: ahora es scan) |

Sobre corpus RECIÉN escrito los warm reads re-parsean durante ~2s (ventana racy) — comportamiento correcto, converge solo.

## Gates

- Eval A/B same-corpus (swap in-place del archivo, mismo índice vivo, cero writes entre runs): agregados Y per-case **idénticos a 4 decimales**, 28 casos, engine semantic. (El baseline.json comiteado tiene drift de corpus vs hoy — artículos nuevos post-G2 — por eso el gate honesto es el A/B que aísla el efecto del código.)
- typecheck 0 · eslint 0 · coverage exit 0 (2345→2366 tests) · corpus lint 0 · audit high 0.
- Smoke corpus real: get por id y por slug OK; 0 divergentes.

## Follow-up

Work repo NO comparte el patrón agresivo (findById/exists van directo a archivo; full-parse solo en ~7 métodos de filtro sobre ~32 archivos) y su invalidación requiere coordinarse con sus locks y el delete() de dependientes → w-7nnee3c2 con AC.