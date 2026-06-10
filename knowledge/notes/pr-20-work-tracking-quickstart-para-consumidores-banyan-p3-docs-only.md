---
id: k-e9atys0k
title: PR-20: work tracking quickstart para consumidores (Banyan P3, docs-only)
slug: pr-20-work-tracking-quickstart-para-consumidores-banyan-p3-docs-only
category: solution
tags: [banyan, work-tracking, docs, consumer-driven, adoption]
codeRefs: [docs/consumer-setup.md]
references: [k-3zo9w9dg, k-hjc2eo08]
createdAt: 2026-06-10T10:57:30.996Z
updatedAt: 2026-06-10T10:57:30.996Z
---

Quinto y último fix consumer-driven Banyan. Rama `docs/banyan-p3-work-quickstart`. `workArticleCount: 0` en Banyan — el subsistema work/convoys/fases entero sin adoptar; la colisión de dos waves concurrentes del 2026-06-10 habría sido visible con un `work list` previo.

## Veredicto de fricción (experimentada, no teorizada)

El subsistema es maduro — NO falta ningún comando para un quickstart de 3 pasos. Toda la fricción es de conocimiento:
1. `GUARD_FAILED: min_enrichment_met` no nombra los roles pendientes ni el remedio (`work enrich <id> --role <r> --status contributed|skipped`) — el único momento "leer help dos veces".
2. **Trap de fallo silencioso:** errores de guard/transición salen por stderr con stdout vacío; con el `2>/dev/null` que el propio doc recomendaba, un advance bloqueado es invisible salvo por exit code.
3. Ladders por template sin documentar: `spike` = planning → enrichment → done (el registro honesto más barato para waves de research); `feature` camina las 5 fases.
4. Artículos `done` son inmutables (audit record by design) — `work delete` falla en terminal.

## Qué shippeó (docs-only, +41 líneas)

Sección "Work tracking quickstart (wave registration)" en consumer-setup.md: hábito anti-colisión (`work list` ANTES de lanzar wave, filtro `--wave <name>`), un `work create --tags wave-…` por wave in-flight, advance con `--reason`, `work close <id> --pr <n>` al mergear; bloque "Guards and ladders (observed behaviour, not theory)"; tabla CLI↔MCP (`list_work`/`create_work`/`advance_phase` con `skip_guard:{reason}`/`contribute_enrichment`). Cada comando ejecutado en el clon antes de documentarse.

## Follow-up identificado (NO implementado)

Ergonomía de guards del work CLI: que `GUARD_FAILED` nombre roles pendientes + remedio, y considerar eco a stdout del error. Tarea registrada aparte.

## Verificación

typecheck 0 · eslint 0 · corpus lint exit 0 · transcript de aceptación completo en PR #150 (create → list → guard real → skip-guard auditado → cleanup del clon a estado más limpio que el encontrado).