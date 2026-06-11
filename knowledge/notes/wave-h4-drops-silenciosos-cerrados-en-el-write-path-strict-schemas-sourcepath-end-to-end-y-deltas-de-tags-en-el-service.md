---
id: k-2e0b09bj
title: Wave H4: drops silenciosos cerrados en el write-path — strict schemas, sourcePath end-to-end y deltas de tags en el service
slug: wave-h4-drops-silenciosos-cerrados-en-el-write-path-strict-schemas-sourcepath-end-to-end-y-deltas-de-tags-en-el-service
category: solution
tags: [wave-h, mcp-tools, api-hygiene, silent-failure, validation]
codeRefs: [src/knowledge/schemas.ts, src/work/schemas.ts, src/knowledge/service.ts, src/knowledge/repository.ts, src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/cli/knowledge-commands.ts, tests/unit/tools/tool-schema-parity.test.ts]
references: [w-4yr6svbk, k-qvn9uqqu]
createdAt: 2026-06-11T12:45:43.214Z
updatedAt: 2026-06-11T12:45:43.214Z
---

Cierra w-4yr6svbk. Rama `fix/h4-tool-silent-drops`.

## La enfermedad, no solo el síntoma

El caso conocido era el tool MCP `update_article` ignorando `sourcePath`. El sweep sistemático (extracción 3-agentes de las superficies exactas tool/service/repo/CLI, en ambas direcciones) encontró la raíz: **los 4 Zod schemas del write-path usaban strip-mode** — toda clave no declarada moría sin error. El comentario en `CreateWorkArticleInputSchema` ya registraba una mordida previa (dependencies/blockedBy stripeados hasta que alguien lo notó).

Política aplicada: **exponer con validación, o rechazar con ValidationError explícito. Nunca silencio.**

## Lo que cambió

1. **`z.strictObject` en los 4 write-input schemas** (knowledge create/update, work create/update). Clave desconocida → VALIDATION_FAILED. Alineado con la razón documentada del propio ADR-020 ("que el typo grite, no que desaparezca"). Knock-on intencional: el dashboard POST devuelve 400 ante campos basura; `update_work {phase}` ahora ERRA en vez de no-op silencioso (la fase se mueve solo por advance_phase). Los frontmatter schemas (read-path) siguen laxos — los corpora Option-A llevan claves custom legítimas.
2. **`sourcePath` end-to-end**: service schemas (create+update) + tools `create_article`/`update_article` + items de ambos batch + CLI `--source-path` (paridad T4).
3. **Bug nuevo cazado por el sweep**: un rename REAL (`new_slug` ≠ slug actual) descartaba `extraFrontmatter` y `sourcePath` en silencio — `WriteWithSlugInput` no tenía los campos y `renameAndUpdate` no los forwardeaba (el mismo call con rename no-op SÍ los aplicaba). Fix en interface + ambos repos (file e in-memory) + plan de staged writes.
4. **Deltas de tags al service**: `add_tags`/`remove_tags` ahora viven en el schema de update con la exclusividad vs `tags` como refine. `updateOneWithoutRebuild` resuelve el delta contra los tags actuales (`applyTagDelta` ya normaliza). Resultado: single update, batch y rename comparten UNA implementación — antes solo el handler MCP single los resolvía, así que `batch_update_articles` rompía su promesa documentada ("same fields as update_article") dropeándolos. El handler MCP se simplificó a pass-through.
5. **Advertisement**: items de batch declaran `extraFrontmatter`/`sourcePath`/`add_tags`/`remove_tags`; `create_work` declara `dependencies`/`blockedBy` (service y CLI ya los soportaban — gap de descubribilidad).

## Veredictos de rechazo (sistema-owned, ahora ruidosos)

- knowledge create: `id`/`createdAt`/`updatedAt` — existen en el repo-input para ingestion directa; por el service son forja de identidad/historia → rechazo.
- work create: `phase`/`enrichmentRoles`/`reviewers`/`phaseHistory`/timestamps → rechazo; lifecycle es del sistema.

## Documentado sin cambiar (backlog consciente)

CLI ignora flags desconocidos (parseFlag naive, rasgo CLI-wide); CLI sin flags para references/slug (create) y codeRefs/references/new_slug (update) — gaps de descubribilidad, no de silencio; work lead/assignee no-clearables; advancePhase options sin Zod; work tags sin normalizar en write (lint tag_hygiene cubre).

## Verificación

TDD: 24 pins nuevos en RED verificado (propiedad ausente, sourcePath undefined end-to-end, strict "expected true to be false", batch tags sin merge, rename conservando el mapa viejo) + 2 REDs de CLI. Los 2 pins viejos que fijaban el strip ("extra properties are stripped") se voltearon conscientemente. Gates: typecheck 0 · eslint 0 · coverage exit 0 (2366→2392) · corpus lint 0 · audit 0. Eval N/A verificado: el diff no toca src/search ni src/eval.