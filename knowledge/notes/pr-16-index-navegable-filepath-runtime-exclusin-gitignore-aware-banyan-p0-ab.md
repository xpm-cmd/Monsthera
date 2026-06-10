---
id: k-zv7qfvll
title: PR-16: index navegable — filePath runtime + exclusión gitignore-aware (Banyan P0-AB)
slug: pr-16-index-navegable-filepath-runtime-exclusin-gitignore-aware-banyan-p0-ab
category: solution
tags: [banyan, wiki-index, consumer-driven, file-repository, gitignore]
codeRefs: [src/knowledge/wiki-bookkeeper.ts, src/knowledge/file-repository.ts, src/knowledge/repository.ts, src/structure/service.ts, tests/unit/knowledge/file-repository-filepath.test.ts]
references: [k-3zo9w9dg]
createdAt: 2026-06-10T09:42:22.570Z
updatedAt: 2026-06-10T09:42:22.570Z
---

Primer fix consumer-driven desde Banyan (corpus matemático Lean, 64+ artículos ID-named). Rama `feat/banyan-p0-index`. Dos bugs del generador de wiki index, un PR.

## P0-B — links del index por filename real (cierra ISSUE-004 de Banyan)

**Bug:** `WikiBookkeeper.rebuildIndex` reconstruía cada link como `notes/<slug>.md`, pero los archivos de un consumidor Option-A pueden tener cualquier nombre (Banyan: `k-91-HB-037-<slug>.md`). En Banyan: 86/86 links del index 404eaban en GitHub/filesystem.

**Fix:** `KnowledgeArticle.filePath?: string` — **metadata runtime, jamás serializada a frontmatter** (`buildArticleFrontmatter` enumera keys explícitas; test de pureza pinea que ni el patch minimal-diff ni el serialize completo la escriben). `FileKnowledgeRepository` la puebla al leer (`relativeArticlePath()`, forward slashes, resuelve contra el root dueño). Consumidores: index (línea de artículo + tabla de policies) y `getOrphanCitations.sourcePath` — todos con fallback `notes/<slug>.md` cuando no hay path (repos in-memory → comportamiento byte-idéntico).

## P0-A — exclusión gitignore-aware del index (ISSUE-005 de Banyan)

**Bug:** el index commiteado de Banyan listaba 23 notas `handoff-*` gitignoradas (estado de sesión local) → 23 entradas colgantes en todo checkout fresco.

**Fix:** `detectIgnoredPaths()` en el bookkeeper: `execFile("git", ["check-ignore", "--stdin", "-z"], { cwd: markdownRoot })` — argv array sin shell, NUL-delimited en ambas direcciones, handler de EPIPE para la carrera git-ausente. Exit 1/128/ENOENT → degrada uniforme a "nada ignorado" (repos sin git conservan comportamiento). Excluye knowledge Y work ignorados; emite `> N local-only article(s) omitted (gitignored).` sin nombrarlos. **Clave: la exclusión sigue `.gitignore`, no patrones de nombre** — Monsthera commitea sus propios handoffs y siguen listados (verificado: self-reindex → diff solo-timestamp en su index.md con 115+22 entradas).

## Aceptación cross-repo (clon scratch de Banyan, verbatim en PR #146)

reindex → 64 knowledge, 0 work · `grep -c "handoff-"` index = **0** (era 23) · `check_index.py` exit **0**, 0 dangling, 0 warnings · links **64/0 missing** (era 86/86) · spot-check: `k-00-scope-seed.md` (slug `scope-seed`) ahora linkea el archivo real.

## Gotcha preexistente descubierto (follow-up, NO arreglado aquí)

`update()` sobre un artículo cuyo archivo es ID-named escribe un archivo NUEVO slug-named y deja el original — path de escritura duplicada anterior a este cambio. Relevante para consumidores Option-A que editen vía CLI/MCP. Pendiente como tarea aparte.

## Verificación

typecheck 0 · lint 0 · coverage EXIT 0 (lines 72.67 / branches 61.4 / functions 81.78) · **2262 passed | 3 skipped** (+11) · corpus lint exit 0 · TDD 8-red → 21-green.