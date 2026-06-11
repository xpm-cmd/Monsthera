---
id: k-aua5adqn
title: Wave F1+F4: el smoke contra Dolt real encontró un bug de id en su primer contacto; ADR-014 duplicado renumerado a 021
slug: wave-f1f4-el-smoke-contra-dolt-real-encontr-un-bug-de-id-en-su-primer-contacto-adr-014-duplicado-renumerado-a-021
category: solution
tags: [wave-f, dolt, smoke-test, persistence, adr]
codeRefs: [tests/smoke/dolt-real-smoke.test.ts, src/persistence/dolt-orchestration-repository.ts, docs/adrs/021-portable-workspace-operations.md]
references: [k-jvccuix2, k-3zo9w9dg]
createdAt: 2026-06-11T06:03:55.761Z
updatedAt: 2026-06-11T06:03:55.761Z
---

Rama `chore/f4-adr014-rename` (F4+F1 combinados, seccionados).

## F1 — el argumento definitivo a favor de los smoke tests reales

Los 4 repos Dolt estaban 100% mockeados. El smoke opt-in nuevo (`MONSTHERA_DOLT_SMOKE=1`, base efímera creada/destruida por corrida, la DB viva jamás se toca) corre UN happy path real: schema init + roundtrip de search-document + roundtrip de orchestration-event.

**El primer contacto real encontró un bug inmediatamente**: el schema declara `orchestration_events.id INT AUTO_INCREMENT`, pero `logEvent` generaba e insertaba un id STRING `evt-*` y se lo devolvía al caller — Dolt real lo coerce al escribir, así que **el id que recibía el caller no existía en la base** (cualquier correlación posterior por ese id falla en silencio en deployments doltEnabled). Los mocks jamás podían verlo: honraban el string. Fix: la base asigna el id (AUTO_INCREMENT), `logEvent` devuelve el `insertId` persistido, `parseEventRow` stringifica la columna numérica.

Detalle de debugging: tsx no transforma imports con paths absolutos fuera del repo — el probe script tuvo que copiarse dentro del repo con imports relativos.

## F4 — ADR-014 duplicado

`014-portable-workspace-operations.md` → **ADR-021** (siguiente número libre), con nota de renumeración en el header. Convoy-dashboard conserva 014: su identidad está horneada en historia de PRs mergeados, la memoria S4 y la nota canónica de diseño — toda referencia histórica "ADR-014" al convoy sigue correcta. Referrers vivos actualizados (bootstrap guide, self-update runbook ×3, prompt M3). El artículo ingestado se renombró vía `update_article new_slug` — **el fix A1 renombrando el MISMO archivo, cero duplicados** — pero ojo: el tool MCP no expone `sourcePath` (silenciosamente ignorado); frontmatter + H1 del body corregidos por edición directa (Option A) + verificación con `knowledge get`.

## Verificación

Smoke 3/3 contra el daemon vivo · suite 2337 + 3 skipped (el smoke, por defecto) · gate completo verde con floors F3.