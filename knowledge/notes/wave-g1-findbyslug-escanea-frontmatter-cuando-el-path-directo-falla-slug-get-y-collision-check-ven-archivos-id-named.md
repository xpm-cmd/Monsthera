---
id: k-p90ik5jo
title: Wave G1: findBySlug escanea frontmatter cuando el path directo falla — slug-get y collision-check ven archivos ID-named
slug: wave-g1-findbyslug-escanea-frontmatter-cuando-el-path-directo-falla-slug-get-y-collision-check-ven-archivos-id-named
category: solution
tags: [wave-g, consumer-driven, banyan, file-repository, read-path]
codeRefs: [src/knowledge/file-repository.ts, tests/unit/knowledge/file-repository-filepath.test.ts, tests/unit/knowledge/file-repository-fallback.test.ts]
references: [w-c09d7wa9, k-lyfpgowg]
createdAt: 2026-06-11T11:09:45.945Z
updatedAt: 2026-06-11T11:09:45.945Z
---

Cierra w-c09d7wa9 (follow-up registrado en Wave A1, k-lyfpgowg). Rama `fix/g1-findbyslug-id-named`.

## El bug

`FileSystemKnowledgeArticleRepository.findBySlug` era puramente path-derivado: leía `notes/<slug>.md` directo (primary → fallback worktree) y jamás miraba frontmatter. Para corpora Option-A con archivos ID-named (Banyan: `k-00-scope-seed.md` con `slug: scope-seed`):

1. `get_article(slug)` / `knowledge get <slug>` → NotFound aunque el artículo exista.
2. El collision-check de slug explícito en `KnowledgeService.createArticle` (service.ts:97) delega en `findBySlug` → no veía la colisión. **Síntoma real medido en el red test:** create retornaba `ok` — el slug pedido se sustituía en silencio por `uniqueSlug(title)` en `repo.create` (la defensa de `existingSlugs` vía `loadAll` SÍ ve frontmatter), así que no nacía un duplicado físico, pero el caller recibía un slug distinto al pedido sin error.

## Fix (~10 líneas, solo el repositorio)

En `findBySlug`: si el path directo (primary y fallback) da NotFound, **scan por frontmatter vía `loadAll()`** antes de rendirse. Claves del diseño:

- `loadAll()` ya implementa primary-wins del fallback worktree → el scan hereda esa semántica gratis, sin re-implementarla.
- El guard de StorageError se movió arriba (`if (!(primary.error instanceof NotFoundError)) return primary`) — un archivo corrupto en el path directo sigue siendo error duro; el scan jamás lo enmascara.
- Fast-path slug-named intacto: el scan solo corre donde hoy había NotFound → cambio estrictamente aditivo (cero cambio de comportamiento para casos que ya resolvían).
- El servicio no se tocó: arreglar `findBySlug` cura ambos síntomas porque el collision-check ya delegaba en él.

## Verificación

TDD 4-red→green (scan ID-named primary, scan ID-named en fallback dir, primary-wins en colisión de scan, create-colisión retorna ALREADY_EXISTS y el corpus queda con 1 solo archivo) + 1 pin del NotFound slug-shaped. Gate: typecheck 0 · eslint 0 · coverage exit 0 (2345 tests, suite 2340→2345) · corpus lint exit 0 · audit high exit 0. No toca ranking → eval gate no aplica.

**Aceptación en clon scratch de Banyan (84 artículos ID-named):** `knowledge get scope-seed` resuelve `k-00-scope-seed` con título y metadata completos — antes del fix: NotFound.