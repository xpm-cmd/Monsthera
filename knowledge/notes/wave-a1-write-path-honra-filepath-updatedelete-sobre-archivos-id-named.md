---
id: k-lyfpgowg
title: Wave A1: write path honra filePath — update/delete sobre archivos ID-named
slug: wave-a1-write-path-honra-filepath-updatedelete-sobre-archivos-id-named
category: solution
tags: [wave-a, consumer-driven, banyan, file-repository, write-path]
codeRefs: [src/knowledge/file-repository.ts, tests/unit/knowledge/file-repository-filepath.test.ts, src/core/file-lock.ts]
references: [k-zv7qfvll, k-3zo9w9dg]
createdAt: 2026-06-10T11:40:02.450Z
updatedAt: 2026-06-10T11:40:02.450Z
---

Cierra el gotcha registrado en PR-16 (k-zv7qfvll): todo el write path resolvía su target como `notes/<slug>.md`, ignorando el `filePath` runtime. Rama `fix/a1-write-path-id-named`.

## La causa raíz era TRES bugs, no uno

Para un artículo cuyo archivo es ID-named (consumidor Option-A, ej. `k-00-scope-seed.md` con slug `scope-seed`):

1. **`update()` fallaba con StorageError y envenenaba el corpus** — peor que el duplicado reportado. El lock de `update()` se llaveaba en `articlePath(slug)` y `withFileLock` hace O_CREAT-touch del target → nacía un `notes/<slug>.md` VACÍO → el `findById` interno (loadAll) reventaba parseando el archivo vacío → update fallaba Y el archivo envenenado rompía todo `loadAll()` posterior del corpus.
2. **`writeWithSlug` (rename explícito) duplicaba**: escribía `notes/<new-slug>.md` y el `rm` del viejo apuntaba a `notes/<old-slug>.md` (inexistente) → el original quedaba.
3. **`delete()` era no-op silencioso**: `fs.rm(notes/<slug>.md, {force:true})` tragaba el ENOENT y reportaba éxito con el archivo intacto.

## Fix

`resolveWritePath(article)` privado: prefiere `markdownRoot + article.filePath` (observado al leer, PR-16) con fallback a `articlePath(slug)`. Cuatro call-sites:

- `writeArticle`: in-place → path real; rename → canónico `notes/<new-slug>.md` + rm del viejo en su path REAL; `filePath` del retorno se deriva del target real (`relativeArticlePath`), ya no hardcodeado.
- `tryMinimalDiffWrite`: lee/escribe el path real → **el minimal-diff de T5 ahora aplica a archivos ID-named** (antes ni siquiera encontraba el archivo y degradaba a full-serialize+duplicado).
- Lock de `update()`: llavea el path real (sin touch fantasma).
- `delete()`: rm del path real.

Writes siempre resuelven contra el root PRIMARIO (jamás el worktree fallback) — semántica preexistente preservada.

## Verificación

TDD 5-red→green (los red de update fallaban con `.ok=false` por el envenenamiento — evidencia del bug #1). Knowledge suite 229/229. Gate: typecheck 0 · eslint 0 · coverage exit 0 (2299 tests; lines 73.04/branches 61.91/funcs 81.95) · corpus lint exit 0 · audit high exit 0.

Aceptación en clon scratch de Banyan (72 artículos ID-named): body update → mismo archivo, 72 archivos, cero `scope-seed.md` fantasma · tags-only update → line-diff EXACTO de 2 líneas (`tags:`+`updatedAt:`), formato exótico (flow-style con `:`) byte-preservado · delete → 72→71, archivo real fuera · `knowledge list` post-ops → 71, corpus sin poison files.

## Follow-up registrado

w-c09d7wa9 — `findBySlug` sigue path-derivado: `get_article(slug)` da NotFound para ID-named y el collision-check de slug explícito en create no ve la colisión (permite slugs duplicados).