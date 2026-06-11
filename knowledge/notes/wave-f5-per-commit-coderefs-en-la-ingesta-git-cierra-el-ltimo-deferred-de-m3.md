---
id: k-p4f05mkz
title: Wave F5: per-commit codeRefs en la ingesta git — cierra el último deferred de M3
slug: wave-f5-per-commit-coderefs-en-la-ingesta-git-cierra-el-ltimo-deferred-de-m3
category: solution
tags: [wave-f, ingest, git-history, code-refs, deferred-closed]
codeRefs: [src/ingest/service.ts, src/sessions/facts-extractor-git.ts, tests/unit/ingest/git-ingestion.test.ts]
references: [k-aua5adqn, k-3zo9w9dg]
createdAt: 2026-06-11T06:09:03.101Z
updatedAt: 2026-06-11T06:09:03.101Z
---

Rama `feat/f5-percommit-coderefs`. **Cierra el último deferred de M3** (PR-15 per-commit codeRefs) — con esto el backlog de la auditoría 2026-06-10 queda íntegramente ejecutado.

## Diseño

`listCommitFiles()` en facts-extractor-git (`git show --name-only --format= <sha>`); `ingestCommits` lo cablea por commit con **cap de 20 archivos** (un sweep monstruoso no debe inflar un artículo) y **fail-open**: si git falla, codeRefs queda vacío en vez de hundir la ingesta. El fail-open además es lo que mantiene verdes sin tocar los tests preexistentes (su stub runner erroriza en llamadas git inesperadas — exactamente el caso de fallo).

Los artículos de commits ahora son ciudadanos de primera del code-ref intelligence: owner index, impact analysis, boosts de mode=code en el pack.

## Verificación

TDD 2-red→green + pin del fail-open · 16/16 ingest · **aceptación real en clon scratch del propio repo**: `ingest git --range HEAD~2..HEAD` produjo artículos cuyos codeRefs son exactamente los archivos cambiados de cada commit (el artículo del commit de F1 lleva `src/persistence/dolt-orchestration-repository.ts` + `tests/smoke/dolt-real-smoke.test.ts`) · gate completo (typecheck 0 · eslint 0 · coverage exit 0 con 2340+3 skipped · corpus lint 0 · audit high 0).