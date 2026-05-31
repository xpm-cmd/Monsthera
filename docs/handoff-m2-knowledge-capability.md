# Handoff — M2 (knowledge-capability plan)

> **Paste this into a fresh session to start M2:**
>
> > Trabaja **M2** del plan knowledge-capability de Monsthera. Lee primero `docs/handoff-m2-knowledge-capability.md` (este archivo) y la memoria (`project-knowledge-capability-plan`). Ejecuta los PRs de M2 **en orden, uno por PR**, con la cadencia: testear local → commit → push → abrir PR → esperar CI verde → merge → siguiente. Empieza por **PR-7** (tests de caracterización) porque fija el ranking antes de que PR-9/PR-11 lo toquen.

---

## Dónde estamos (no rehacer)

- **M0 + M1 COMPLETOS y mergeados.** `main` @ `e485a84`. Suite: **2090 tests / 159 files**, verde.
- PRs ya en `main`:
  - #122 CI (`.github/workflows/ci.yml`) · #123 eval harness (`monsthera eval`, `src/eval/`) · #124 `TextGenerator` pluggable (Ollama+OpenAI+Stub, `src/core/text-generator.ts`).
  - #125 custom-frontmatter authoring (ADR-020 P1) · #126 `think` síntesis (`src/search/think-*.ts`) · #127 work→knowledge distillation (`src/work/distillation.ts`).
- **El lazo de compounding ya vive:** cerrar un work (`feature`/`bugfix`/`refactor` → `done`) destila un `solution`/`decision`; `think` lo lee de vuelta como respuesta citada (knowledge + work) con gap analysis.

Plan completo (esta sesión, puede no estar en la próxima): `~/.claude/plans/genera-un-plan-completo-floofy-shamir.md`. La memoria `project-knowledge-capability-plan` tiene el resumen ejecutable.

## Cadencia (la pidió el usuario)
**test local → commit → push → PR → CI verde → merge**, un PR pequeño por item, rama por PR (`git checkout -b ...` desde `main`). Commits terminan en `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`; PR bodies en `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Mergear con `gh pr merge <n> --merge --delete-branch` y `git checkout main && git pull`.

## Gotchas verificados (ahorran tiempo)
- **CI corre sin Dolt ni Ollama**: exporta `MONSTHERA_DOLT_ENABLED=false MONSTHERA_SEMANTIC_ENABLED=false` para reproducir CI local. La suite es hermética así.
- **Coverage es report-only** en CI: los umbrales de `vitest.config` (lines/funcs 80%, branches 70%) NO se cumplen hoy (lines ~73%, branches ~61%). No intentes gatearlo; subir cobertura es un PR aparte.
- **`monsthera lint`** sale ≠0 sólo con findings de severidad `error` (warnings como orphan_citation/tag_near_duplicate no rompen). `docs/**` no lo toca el corpus lint ni eslint.
- **Edit tool**: requiere haber leído el archivo con la tool `Read` (no basta `sed`/`grep` por Bash) antes de editar.
- **Líneas movidas**: `think` agregó ~80 líneas a `src/search/service.ts`. **No confíes en números de línea viejos** — usa `grep` para localizar `scoreContextPackItem`, `buildContextPack`, etc.
- Tests de integración: usa `createTestContainer()` (`src/core/container.ts`). Para avanzar un work rápido por fases: `workService.advancePhase(id, phase, { skipGuard: { reason: "test" } })`.

## Piezas reutilizables (ya existen)
- **LLM**: `container.textGenerator` (PR-3). `SearchService.setTextGenerator()` inyecta post-construcción. Patrón degradación: `healthCheck()` falla o `generate()` vacío → degradar. Úsalo en PR-9 (contradicciones LLM) y PR-11 (reranker).
- **Eval**: `monsthera eval --json` + baseline en `tests/eval/baseline.json` (capturado semantic-off). PR-11 debe mantener-o-mejorar contra él. Hallazgo registrado: **semántica ON rankea peor que BM25-only** en queries de título (NDCG@5 0.68 vs 1.0) → motiva PR-10/PR-11.
- **think gaps**: `src/search/think-synthesis.ts` ya computa gaps `stale`/`uncited` deterministas y mapea `missing`/`contradictory` del LLM. PR-9 debe **alimentar `contradictory`** sistemáticamente.
- **Fail-open**: patrón en `WorkService.emitConvoyLeadCancelledWarnings` / `maybeDistillToKnowledge` (warn-log + swallow).

---

## M2 — PRs en orden

### PR-7 · Tests de caracterización (ranking + citation) — M — **HACER PRIMERO**
Fija el comportamiento actual **antes** de que PR-9/PR-11 toquen ranking/citación.
- `tests/unit/search/context-pack-ranking.test.ts`: pin de `scoreContextPackItem` (grep en `src/search/service.ts`) — orden + scores sobre fixtures.
- Tests de rename atómico + reescritura de wikilinks (ruta más riesgosa de knowledge).
- Pin de `verifyCitedValues` (`src/structure/service.ts`) antes de que PR-9 lo extienda.
- **Aceptación**: suite verde; un cambio futuro que altere el orden de ranking rompe estos tests (señal, no sorpresa).

### PR-8 · Reporte global de staleness — S
Hoy la detección de stale-refs es por-ítem dentro de `buildContextPack`. Falta consolidado.
- `StructureService.buildStalenessReport() → { staleArticles, staleCodeRefs, sourceNewer }`. Reusa `inspectKnowledgeArticle`/`inspectWorkArticle` (`src/context/insights.ts`), `gaps.missingCodeRefs` + `codeRefExists` (`src/structure/service.ts`), `inspectSourceSync`.
- Exponer en `monsthera doctor` + tool MCP `refs_stale` (hermano de `refs-tools.ts`). Pure read.
- **Aceptación**: `monsthera doctor` lista artículos stale + refs rotas; tool MCP devuelve el reporte.

### PR-9 · Detección de contradicciones — M (depende de PR-7)
- `StructureService.detectContradictions(idOrSlug?) → ContradictionFinding[]` (espeja `CitationValueFinding`).
  - **Tier determinista (primero)**: pares con `shared_tag`/`code_ref` que divergen en un canonical value (reusa lógica `canonical_value_mismatch` de `src/work/lint.ts`).
  - **Tier LLM (opcional)**: sólo pares adyacentes en el grafo (evita O(n²)); usa `container.textGenerator`; degrada a determinista sin LLM.
- Wire: familia lint `contradictions` (severidad **warning**, no gatea pre-commit) + `monsthera doctor`. **Alimenta los gaps `contradictory` de `think`.**
- **Aceptación**: `monsthera lint --registry contradictions` reporta un par contradictorio; `think` empieza a poblar `contradictory` sistemáticamente.

### PR-10 · Knobs config-driven — S (prerequisito de PR-11)
Hoy hardcodeados: BM25 `K1`/title-boost (`src/search/in-memory-repository.ts`), umbrales freshness `14/45` (`src/context/insights.ts`), pesos de mode-bonus (`scoreContextPackItem`).
- Extender `SearchConfigSchema` (`src/core/config.ts`): `bm25K1`, `titleBoost`, `freshnessFreshDays`, `freshnessStaleDays`, `rerankEnabled`, `mode` (`conservative|balanced|tokenmax`). Env `MONSTHERA_SEARCH_*` (mismo patrón que el resto). Todo `.default()` → back-compat.
- Thread a `InMemorySearchIndexRepository`, `inspectKnowledgeArticle` (param thresholds), `scoreContextPackItem`.
- **Aceptación**: cambiar `MONSTHERA_SEARCH_BM25K1` altera el ranking medible (vía `monsthera eval`); defaults preservan comportamiento (PR-7 sigue verde).

### PR-11 · Etapa reranker — M (depende de PR-2 eval + PR-10)
- Interface `Reranker` (espeja `EmbeddingProvider`). Etapa en `SearchService.search()` entre `mergeResults` y `rerankForTrust`, tras flag/modo.
- Impl cross-encoder vía `container.textGenerator` sólo sobre top-K (≈20; el pool `limit*3` ya existe) + stub no-op default. Degrada a identidad ante fallo.
- **Aceptación (gate eval)**: con reranker on, P@5/NDCG@5 ≥ `tests/eval/baseline.json`; con stub, idéntico a hoy; fallo de LLM no rompe `search`.

### PR-12 · Onboarding de embeddings — S
- Check en `monsthera doctor` que llama `embeddingProvider.healthCheck()` (ya da error accionable "Run: ollama pull nomic-embed-text") + helper `monsthera self enable-semantic` (flip `semanticEnabled` + `fullReindex`) + doc README. Pura ergonomía.

---

## Después de M2 → M3
PR-13 provenance + salience (`origin` enum en extraFrontmatter — ya autorable; salience-bonus en ranking detrás de config, validado por eval) · PR-14 query+lint de frontmatter custom (ADR-020 P2/P3) · PR-15 ingesta git/PR.

## Cierre de cada PR
Considera una knowledge note de solución por PR (convención del repo) y actualizar la memoria `project-knowledge-capability-plan` con el PR# + sha de `main`. Al cerrar M2, corre `monsthera eval` para evidenciar la ganancia de calidad de recuperación vs el baseline.
