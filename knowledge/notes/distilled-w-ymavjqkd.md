---
id: k-r1kmcqoj
title: Solution: Wave A: quick fixes consumer-driven — update() ID-named duplica + GUARD_FAILED mudo
slug: distilled-w-ymavjqkd
category: solution
tags: [wave-a, consumer-driven, banyan, distilled]
codeRefs: [src/knowledge/file-repository.ts, src/work/guards.ts, src/cli/work-commands.ts]
references: [w-ymavjqkd]
createdAt: 2026-06-11T00:14:31.744Z
updatedAt: 2026-06-11T00:14:31.744Z
origin: distilled
distilled_from: w-ymavjqkd
---

> Distilled from work [w-ymavjqkd] on completion. Origin: `distilled`.

## Objective

Dos quick fixes consumer-driven descubiertos en el workstream Banyan 2026-06-10 (ver k-3zo9w9dg):

- **A1** — `update()` sobre un artículo cuyo archivo es ID-named (consumidor Option-A, ej. `k-91-HB-037-<slug>.md`) escribe un archivo NUEVO `<slug>.md` y deja el original (gotcha registrado en k-zv7qfvll). Desde PR-16 existe `KnowledgeArticle.filePath` runtime — el write path debe reusarlo cuando está presente.
- **A2** — `GUARD_FAILED: min_enrichment_met` no nombra los roles pendientes ni el remedio (fricción registrada en k-e9atys0k). El mensaje debe enumerar roles pendientes + sugerir `work enrich <id> --role <r> --status contributed|skipped` (o `--skip-guard-reason`). stderr sigue siendo el canal.

## Acceptance Criteria

- A1: TDD — update sobre fixture ID-named modifica el MISMO archivo, cero duplicados; rename explícito (`new_slug`) sigue funcionando. Gate completo verde.
- A2: TDD sobre guards + un test CLI; el mensaje enumera roles pendientes y el remedio exacto. Gate completo verde.
- 1 PR pequeño + 1 knowledge note (categoría solution) por fix. PRs apilados (tocan knowledge/).
- Sin regresión en `monsthera eval` al cierre de la wave.

## Status 2026-06-10 — código completo, PRs abiertos

- A1 → PR #152 (`fix/a1-write-path-id-named`), nota k-lyfpgowg. Causa raíz triple (duplicado + lock-touch envenenando corpus + delete no-op silencioso); aceptación en clon scratch Banyan (72 ID-named): minimal-diff de 2 líneas exactas, delete real, corpus limpio. Follow-up registrado: w-c09d7wa9 (findBySlug path-derivado).
- A2 → PR #153 apilado sobre #152 (`fix/a2-guard-failed-actionable`), nota k-l6o5ujfw. `GuardEntry.recoveryHint` (espejo sync del patrón async); smoke CLI verbatim verde.
- **Eval gate de cierre: SIN regresión atribuible a la wave** (mismo engine bm25: NDCG 0.8782 main → 0.8767 rama, MRR idéntico 0.8929). Dos hallazgos PRE-EXISTENTES documentados para C1: (a) engine semantic colapsa el golden set (NDCG 0.11 vs 0.88 bm25, también en main); (b) baseline.json stale vs corpus actual (bm25 0.9449→0.8782 por drift de notas post-auditoría #144–#151).

Pendiente para `done`: merge de #152 y #153 por el usuario.

## Code
- `src/knowledge/file-repository.ts`
- `src/work/guards.ts`
- `src/cli/work-commands.ts`
