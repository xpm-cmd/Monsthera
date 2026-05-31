# Handoff — M3 (knowledge-capability plan)

> **Paste this into a fresh session to start M3:**
>
> > Trabaja **M3** del plan knowledge-capability de Monsthera. Lee primero `docs/handoff-m3-knowledge-capability.md` (este archivo) y la memoria (`project-knowledge-capability-plan`). Ejecuta los PRs de M3 **en orden, uno por PR**, con la cadencia: rama nueva desde `main` **antes de editar** → testear local → commit → push → abrir PR → esperar CI verde → merge → sync. Empieza por **PR-13** (provenance primero — desbloquea PR-15; la mitad *salience* es diferible).

---

## Dónde estamos (no rehacer)

- **M0 + M1 + M2 COMPLETOS y mergeados.** `main` @ `995d4e8` (último código M2 @ `1d13f64`). Suite: **2163 tests**, verde. `monsthera eval` (default) == `tests/eval/baseline.json` (**NDCG@5 1.0, MRR 1.0, P@5 0.2**) — se mantuvo a lo largo de M0–M2.
- **M2 entregó (PRs #129–#135):** PR-7 pins de ranking · PR-8 `buildStalenessReport` + tool `refs_stale` + doctor · PR-9 `detectContradictions` + familia lint `contradictions` + gaps `contradictory` en `think` + doctor · PR-10 knobs `MONSTHERA_SEARCH_*` · PR-11 etapa reranker · PR-12 `self enable-semantic` + doctor Embeddings + README.
- Cada PR tiene su knowledge note (`pr7-…` … `pr12-…`, todas cross-linked). El plan maestro vive en `~/.claude/plans/genera-un-plan-completo-floofy-shamir.md` (sección "M3 — Aditivos / arquitectura", líneas ~308-320). La memoria `project-knowledge-capability-plan` tiene el resumen ejecutable.

## Cadencia (la pidió el usuario)
**rama desde `main` ANTES de editar → test local → commit → push → PR → CI verde → merge → sync**, un PR pequeño por item. `git checkout -b feat/pr13-... main`. Commits terminan en `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; PR bodies en `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Mergear con `gh pr merge <n> --merge --delete-branch` y `git checkout main && git pull --ff-only`. CI: `gh pr checks <n> --watch --interval 20` (≈1m40s).

## Gotchas verificados en M0–M2 (ahorran tiempo)
- **Rama PRIMERO.** En M2 olvidé ramificar antes de editar en PR-8 y PR-9 (quedé en `main`); recuperable con `git checkout -b <rama>` que arrastra el working tree, pero hazlo al principio.
- **CI corre sin Dolt ni Ollama**: `export MONSTHERA_DOLT_ENABLED=false MONSTHERA_SEMANTIC_ENABLED=false` para reproducir CI local (hermético). Gates: `pnpm typecheck` · `pnpm lint` · `pnpm test` · `pnpm exec tsx src/bin.ts lint` (corpus). Coverage es report-only.
- **`pnpm typecheck` ≠ `pnpm test`.** Vitest corre vía esbuild y **NO** type-checkea: un fake de test al que le falta un miembro de interfaz (p.ej. `EmbeddingProvider.embedBatch/modelName`, `TextGenerator.modelName`) pasa en vitest pero rompe `tsc`. Corre **siempre** typecheck además de los tests.
- **Añadir un campo `.default()` a un `*ConfigSchema`** lo hace **requerido en el tipo de salida** (`z.infer`), rompiendo todo test que arme un literal de config inline (en PR-10 rompió 5 archivos). Fixes: (a) relajar el tipo del consumidor — `SearchServiceDeps.config = Omit<…, Knob> & Partial<Pick<…, Knob>>` (cero churn de tests; ver `src/search/service.ts`), o (b) en literales de `MonstheraConfig` completos, `search: { ...defaultConfig(cwd).search, ...overrides }`.
- **`consistent-type-imports`**: un import de valor usado sólo como tipo es **error** de eslint → `import { type X, Y }`.
- **Líneas se mueven** entre PRs — no confíes en números de línea; usa `grep` para `scoreContextPackItem`, `scanCorpus`, `handleSelf`, etc.
- **`monsthera lint`** sale ≠0 sólo con findings `error` (warnings como `orphan_citation`/`tag_near_duplicate`/`contradiction` no rompen). `docs/**` no lo toca el corpus lint ni eslint; `knowledge/**` SÍ lo toca el corpus lint.
- **Edit requiere Read previo** del archivo (no basta `sed`/`grep` por Bash).
- **Tests de integración**: `createTestContainer()` (`src/core/container.ts`). In-memory repos aceptan `id`/`updatedAt`/`createdAt` en `create(...)` (knowledge: string; work: `timestamp(...)` brandeado) — usa esto para fixtures deterministas (ids `articleId("k-a")`, fechas viejas).
- **Knowledge note por PR**: se crea **post-merge** (lleva el sha del merge) y se commitea en la rama del PR **siguiente** como `docs(knowledge): …`. El último PR de un milestone necesita un docs-PR propio (M2 fue #135).

## Piezas reutilizables (ya existen — M3 las usa intensivamente)
- **`extraFrontmatter`** (PR-4, ADR-020 P1): bag de campos custom que round-trippea en create/update (MCP `extraFrontmatter` + CLI `--field k=v`). PR-13 escribe `origin` ahí; PR-14 lo indexa/lintea; PR-15 lo setea a `ingested`.
- **`scoreContextPackItem`** (`src/search/service.ts`, **exportado y pinneado por PR-7**) + **`computeTrustAdjustedScore`**: aquí va el bonus de salience de PR-13. **Cualquier cambio de pesos default rompe los pins de PR-7 a propósito** — actualízalos conscientemente y mantén el default neutral.
- **Config knobs** (PR-10): patrón `SearchConfigSchema` + env `MONSTHERA_SEARCH_*`, todo `.default()`. El bonus de salience va detrás de un knob nuevo (default off/neutral).
- **Eval** (PR-2): `monsthera eval --json` + `tests/eval/baseline.json`. PR-13 debe mostrar **no-regresión** (y, idealmente, mejora) con salience on. Cierra M3 corriendo `monsthera eval`.
- **Familias lint** (`src/work/lint.ts`): `LintRegistry` + `scanCorpus`. PR-9 añadió `contradictions` siguiendo la costura **"computa en el service, mergea en el scanner"** (campos opcionales en `LintScanInput`, gated por `run<Family>`). **PR-14 P3 añade `custom-frontmatter` igual.** Formatter case en `src/cli/lint-commands.ts` (el `switch (f.rule)` es exhaustivo — un rule nuevo sin case rompe `tsc`).
- **`PolicyLoader`** (`src/work/policy-loader.ts`, `{knowledgeRepo, logger}`): carga policy-articles (canonical values, anti-examples). PR-14 P3 define una policy-shape nueva para expectativas de campos custom por categoría, espejando este loader.
- **`list_articles`** ya hace filtrado in-memory por `tag`/`hasCodeRefs` (ADR-005). **PR-14 P2 añade `--filter custom.<key><op><value>` capa por encima**, sin inventar query language.
- **`IngestService.importLocal`** (`src/ingest/service.ts`): pipeline source-file → knowledge article con `sourcePath`. PR-15 añade `importGitHistory`/`importPr` reusando `src/sessions/facts-extractor-git.ts`.
- **`core/runtime-state.ts`** (read/write snapshot, ya inyectado en SearchService): PR-13 cuenta apariciones en packs aquí.
- **Fail-open pattern**: warn-log + swallow (`maybeDistillToKnowledge`, reranker `applyReranker`, `SearchService.loadCanonicalValues`).

---

## M3 — PRs en orden

> Orden por dependencias (plan líneas 48-52): PR-13 dep PR-4+PR-10 · PR-14 dep PR-4 (independiente) · PR-15 dep PR-4+**PR-13**. Regla dura: PR-7 (caracterización) antes de tocar ranking → ya está, así que el bonus de salience de PR-13 queda protegido por los pins de PR-7.

### PR-13 · Provenance + salience — M — **HACER PRIMERO** (desbloquea PR-15)
Dos mitades; la primera es simple y obligatoria, la segunda es opcional/diferible.
- **Provenance (`origin`)** — enum `agent|human|distilled|ingested` en `extraFrontmatter` (usa PR-4). `distillation` (`src/work/distillation.ts`) escribe `distilled` (ya pone `extraFrontmatter:{origin:"distilled", distilled_from}` — **verifícalo y normaliza al enum**); ingest (PR-15) pondrá `ingested`; default `agent`. Hazlo visible/consistente en create/update y en doctor/lint si aplica.
- **Salience (ranking, DIFERIBLE)** — contar apariciones de cada artículo en packs vía `core/runtime-state.ts`; alimentar un bonus **log-amortiguado + cap** en `scoreContextPackItem`/`computeTrustAdjustedScore`, **detrás de un knob de config nuevo (default off/neutral)**, **validado por `monsthera eval`**. **Riesgo: loop de popularidad** (lo popular se vuelve más popular). Mitigación: log-damp + cap + gate por eval; **si eval no muestra mejora, NO mergees la mitad salience — deja sólo provenance**.
- **Aceptación**: `origin` visible/consistente en frontmatter (default `agent`, distillation `distilled`); si entra salience, su bonus está detrás de config y `monsthera eval` muestra no-regresión (pins de PR-7 verdes con default).

### PR-14 · Custom frontmatter query + lint (ADR-020 P2/P3) — M (independiente, sólo dep PR-4)
Cierra los gaps 2 y 3 de ADR-020 (`docs/adrs/020-custom-frontmatter-fields.md`). Se puede hacer en cualquier momento; lo dejo 2º por riesgo bajo y alto valor.
- **P2 — query**: extender el search sync para emitir términos `custom.<key>` de valores **escalares**; añadir `--filter custom.<key><op><value>` (igualdad + comparación numérica) a `knowledge list` y al tool MCP `list_articles`, capa in-memory como los filtros `tag`/`hasCodeRefs` existentes. No-escalares (objetos/arrays) se guardan/devuelven pero **no son filtrables** — documenta el límite (sin truncado silencioso, ADR-012).
- **P3 — validation**: familia lint `custom-frontmatter` (joining `canonical-values`/`anti-examples`/`planning-hash`/`tag-hygiene`/`contradictions`). Define la policy-shape por categoría (campo requerido / tipo / rango escalar) espejando `policy-loader.ts`; añade `CustomFrontmatterFinding` al union `LintFinding`, un `scanCustomFrontmatter` per-article en `lint.ts`, el gate `runCustomFrontmatter` en `scanCorpus`, y el case en el formatter de `lint-commands.ts`. **Severidad warning** por default (no gatea pre-commit; una policy puede subir a `error`).
- **Aceptación**: `knowledge list --filter custom.replicability_score<0.8` (y `list_articles`) filtra; `monsthera lint --registry custom-frontmatter` reporta un campo requerido faltante / fuera de rango contra una policy-article de prueba.

### PR-15 · Ingesta git/PR — M (dep PR-4 + PR-13)
- Extender `IngestService` (`src/ingest/service.ts`) con `importGitHistory`/`importPr`, reusando `src/sessions/facts-extractor-git.ts` → artículos con `extraFrontmatter:{origin:"ingested"}` (PR-13) + `sourcePath` apuntando al commit/PR. Wire CLI `monsthera ingest --git <range>` (y/o `--pr <n>`) + tool MCP hermano de los ingest tools existentes.
- **Aceptación**: `monsthera ingest --git <range>` crea artículos buscables (`search`/`build_context_pack`) con provenance `ingested`. **Pregunta abierta del plan (línea 355):** PR-15 es el único item de M3 que no es un *salto* de conocimiento — si el tiempo aprieta, es el candidato natural a diferir a un M3.5.

---

## Cierre de cada PR
Crea una knowledge note de solución por PR (post-merge, con el sha) y actualiza la memoria `project-knowledge-capability-plan` con el PR# + sha. Commitea la note en la rama del PR siguiente (`docs(knowledge): …`); el último PR de M3 necesitará un docs-PR propio. **Al cerrar M3, corre `monsthera eval`** para evidenciar no-regresión vs baseline.

## Después de M3
Con M0–M3 el sistema cubre los tres "saltos" de conocimiento (síntesis `think`, distillation work→knowledge, higiene activa contradictions/staleness) + provenance/salience + custom-frontmatter end-to-end + ingesta git. Revisar el plan maestro por capacidades C/D restantes no cubiertas y por la decisión salience (mantener o revertir según eval acumulado).
