# Handoff prompt — Monsthera: cola pendiente post-auditoría, en waves

> Pega todo lo que está bajo la línea en una sesión fresca de Claude Code abierta en
> `/Users/xpm/Projects/Github/Monsthera`. Es autocontenido. Este archivo es DESECHABLE:
> bórralo al terminar (el handoff anterior se quedó stale meses — no repitas eso).

---

Trabajas en **Monsthera** (TypeScript MCP server + CLI + dashboard, v3.0.0). El 2026-06-10 se
ejecutó una auditoría integral + 7 PRs (#143 merged; stack #144→#150). Tu trabajo: la cola
pendiente, organizada en **waves por conflicto de archivos** (el orden NO es opinable — está
derivado de qué archivos pisa cada wave). Disciplina de la casa en todo.

## Ground state (verifica, no confíes)

1. `git log --oneline -3` y `gh pr list --state open` — el stack #144→#150 debe estar **mergeado
   en orden** antes de empezar. Si hay PRs abiertos del stack, pídele al usuario mergearlos (en
   orden #144→#150) o espera; NO trabajes sobre el stack sin mergear.
2. Bootstrap Monsthera (CLAUDE.md global): `ToolSearch "monsthera"` → `status()` →
   `build_context_pack(query=<wave actual>, mode="code")`. El contexto completo de la auditoría
   vive en knowledge: **k-3zo9w9dg** (auditoría + backlog), y las notas por PR
   `k-k2ylcsm9, k-dpdrql19, k-zv7qfvll, k-x4xfniba, k-7j6lirme, k-hjc2eo08, k-e9atys0k`.
   Léelas ANTES de re-derivar nada.
3. Baseline verde: `pnpm typecheck && pnpm lint && pnpm coverage` (floors gateando: lines 72 /
   branches 61 / functions 80) y `pnpm exec tsx src/bin.ts lint` exit 0.
4. Ollama: las waves C y D-eval lo necesitan corriendo (`curl localhost:11434/api/tags`;
   `nomic-embed-text` ya está pulled). Si está caído: `ollama serve &`.

## Reglas de proceso NO negociables (aprendidas a golpes)

- **TDD genuino** (red→green: corre el test, VE el fallo correcto, implementa). Lee bytes exactos
  antes de cada Edit.
- **Gate por PR:** typecheck 0 · eslint 0 · `pnpm coverage` exit 0 (los floors muerden) ·
  `pnpm exec tsx src/bin.ts lint` exit 0 · `pnpm audit --prod --audit-level high` exit 0.
  Reporta conteos REALES, nunca los fabriques.
- **1 PR pequeño + 1 knowledge note (categoría `solution`) por PR.** Branch desde main (o
  apilado si tocas `knowledge/` — index.md/log.md conflictúan entre ramas). Commits
  conventional + trailer Co-Authored-By del modelo. NO mergees sin que el usuario lo pida.
- **Cualquier cambio de RANKING pasa por el eval gate:** `pnpm eval --json --k 10` antes/después;
  el agregado (NDCG@10/MRR/contaminationRate) debe mantenerse-o-mejorar vs
  `tests/eval/baseline.json`; los tests de caracterización deben seguir verdes. El golden set
  (28 casos, multi-relevantes + forbiddenArticleIds) existe exactamente para esto.
- **No mezclar repos:** si algo involucra a Banyan, el checkout real (`~/Projects/Github/Banyan`)
  NO se toca; clon scratch (`git clone ~/Projects/Github/Banyan /tmp/banyan-accept`) solo para
  aceptación; entradas ISSUE-NNN paste-ready en la descripción del PR.
- **Harness traps:** stdout de Bash a veces se pierde → `cmd > /tmp/x.txt 2>&1; echo EXIT:$?` y
  Read. macOS no tiene `timeout`. Corre el código ACTUAL (`pnpm exec tsx src/bin.ts`), nunca el
  binario global. Tras cambiar src, `pnpm build` antes de aceptaciones contra `dist/`.
- **Dogfood:** registra cada wave como work article ANTES de arrancarla
  (`work create --title "Wave X: …" --template feature --tags wave-x` — el quickstart está en
  `docs/consumer-setup.md`); `work list` antes de lanzar para ver qué hay en vuelo; `done` al
  mergear. Orquesta con dynamic workflow si el usuario lo pide; si no, agentes background por
  item con archivos disjuntos + fase verify.

## Matriz de conflictos (por qué este orden)

- Wave E (splits) pisa `work/lint.ts`, `core/container.ts`, `search/service.ts`,
  `structure/service.ts`, `dashboard/index.ts` → va AL FINAL, después de que B/C/D terminen de
  editar esos archivos.
- Wave C edita `search/service.ts` (scoring/indexing) → antes del split de search (E).
- Wave D-D0 (split del dashboard router) va PRIMERO dentro de D: las features D1-D2 construyen
  sobre la estructura limpia.
- Waves A y B son disjuntas entre sí y de C/D — pueden intercalarse si conviene.

---

# Wave A — Quick fixes consumer-driven (2 PRs chicos)

**A1 — `update()` duplica archivos ID-named.** Descubierto en P0-AB (nota k-zv7qfvll): un update
sobre un artículo cuyo archivo es ID-named (consumidor Option-A, ej. `k-91-HB-037-<slug>.md`)
escribe un archivo NUEVO `<slug>.md` y deja el original. Desde PR-16, `KnowledgeArticle.filePath`
(runtime) existe — el write path debe reusarlo cuando está presente. Ancla:
`grep -n "writeArticle\|articlePath" src/knowledge/file-repository.ts`. TDD: update sobre fixture
ID-named → el MISMO archivo cambia, cero duplicados; rename explícito (`new_slug`) sigue
funcionando. Aceptación opcional en clon Banyan.

**A2 — `GUARD_FAILED` mudo.** Descubierto en P3 (nota k-e9atys0k): `min_enrichment_met` no nombra
los roles pendientes ni el remedio. Ancla: `grep -n "min_enrichment_met" src/work/guards.ts
src/cli/work-commands.ts`. El mensaje debe enumerar roles pendientes + sugerir
`work enrich <id> --role <r> --status contributed|skipped` (o `--skip-guard-reason`). Mantén
stderr como canal (convención), pero el MENSAJE debe bastar. TDD sobre guards + un test CLI.

# Wave B — DX quick wins (2-3 PRs)

**B1 — trivials:** `ingest git` falta en el help top-level (`src/cli/main.ts` INGEST block;
el subcomando sí lo lista) + **clock inyectado en tests flaky**: `Date.now()`/`setTimeout` reales
en `tests/unit/hardening.test.ts` (~:188), `tests/unit/tools/refs-stale-tool.test.ts` (~:26,
carrera a medianoche UTC), `tests/unit/context/insights-thresholds.test.ts` — inyectar
clock/usar fake timers. Un PR.

**B2 — tool descriptions "when to use":** los ~72 tools MCP (`src/tools/*.ts`) describen QUÉ
hacen, no CUÁNDO usarlos. Añadir patrón "When to use: …" consistente. Mecánico pero amplio;
no cambies schemas, solo descriptions. Un PR.

**B3 — consolidar cliente Ollama:** el patrón fetch+parse+timeout está triplicado en
`src/search/embedding.ts`, `src/sessions/llm-summarizer.ts`, `src/core/text-generator.ts` →
`src/core/ollama-client.ts` compartido. Riesgo medio: NO cambies comportamiento (los tres tienen
tests; deben pasar sin tocar aserciones). Un PR.

# Wave C — Calidad de recuperación (eval-gated; Ollama arriba) (2-3 PRs)

**C1 — recapturar baseline con semantic real.** El baseline actual se capturó con
`engine: "bm25-fallback"` (Ollama caído). Con Ollama arriba: `pnpm eval --json --k 10` → confirma
`engine: "semantic"`, commitea el nuevo `tests/eval/baseline.json` + nota con el delta
bm25→semantic (es la primera medición real del valor de los embeddings sobre el golden set).

**C2 — salience: implementar-o-descartar.** Diferido de PR-13b; NO hay código en src (verifica:
`grep -rn salience src` = vacío). Diseño del plan original: contar apariciones en packs vía
`core/runtime-state.ts`, bonus log-amortiguado + cap en `scoreContextPackItem`
(`src/search/service.ts`), detrás de config knob default-off. CONTRATO: mide contra el golden set
expandido; si NDCG/MRR/contamination no mejoran de forma medible → DESCARTA el código y escribe
la decision note (descartar también es un resultado válido y cierra el deferred para siempre).

**C3 — cf search-term emission.** Los valores escalares de `extraFrontmatter` no se emiten como
términos de búsqueda (verifica: `grep -rn extraFrontmatter src/search` = vacío) — un
`search("replicability")` no encuentra `custom.replicability_score`. Emitirlos en el index doc
build (cuidado con el tokenizer), medir con eval (no debe degradar), tests de roundtrip.

# Wave D — Dashboard UX (3-4 PRs; review visual completo en task/memoria "Wave 6")

Hallazgos verificados con el dashboard corriendo (2026-06-10): **(a)** responsive roto <~800px —
el sidebar colapsa a grilla horizontal full-width y `#content` desaparece (`public/styles.css`);
**(b)** en `/search`, tras tipear, los resultados quedan ~600px bajo el guide del modo
(`public/pages/search.js`) — colapsar guide con query activa o results-first; **(c)** heroes
didácticos enormes en TODAS las páginas sin colapso persistente (patrón `renderHeroCallout`,
persistencia tipo `monsthera-theme` en localStorage); **(d)** nav-badge de Convoys sin
tooltip/aria (`public/lib/sidebar.js`); **(e)** sin página Sessions (rutas en `public/app.js`,
páginas en `public/pages/`; backend: tools session_* existen, falta endpoint dashboard si no hay);
**(f)** sin superficie de eval/engine en System (post-#144 el backend expone `engine` — card con
NDCG/contamination + semantic vs bm25-fallback); **(g)** deps CDN (Lucide unpkg, Cytoscape,
Google Fonts) contra el ethos local-first → self-host; **(h)** las 5 knowledge notes
`dashboard-*` (abril) están desactualizadas (7 nav items vs 11 reales, CORS, auth GET).

- **D0 — split del router** (mecánico, primero): `src/dashboard/index.ts` (~1433 líneas, 18
  handlers en un `handleRequest`) → `src/dashboard/routes/*.ts` por dominio. Cero cambio de
  comportamiento; los tests de dashboard existentes son el arnés.
- **D1 — PRIO 1 UX:** responsive (a) + search results-first (b) + badge tooltip (d). Verifica
  visualmente con Claude Preview (`.claude/launch.json` ya existe: server `monsthera-dashboard`,
  puerto 3791) — screenshots a 1280/768/375.
- **D2 — features:** heroes colapsables (c) + página Sessions (e) + card eval/engine (f).
- **D3 — polish:** self-host assets (g) + footer sidebar críptico + refresh de las notas
  `dashboard-*` (h, via update_article).

# Wave E — File splits restantes (1 PR por archivo; PAUSA tras el primero)

Precedente de extracción: `think-synthesis.ts` / `handoff-renderer.ts`. Cero cambio de
comportamiento; suite como arnés. Orden: **E1** `work/lint.ts` (871 → `rules/` por finding type) ·
**E2** `core/container.ts` (681 → factories por subsistema: dolt-initializer,
search-provider-factory, llm-factory) · **E3** `structure/service.ts` (1260 → code-ref-indexer /
tag-edge-builder / citation-analyzer) · **E4** `search/service.ts` (1040 → hybrid-ranker; think ya
está extraído). **Tras E1: PARA y pide review del usuario antes de seguir** — un refactor de
800+ líneas no se encadena a ciegas aunque el gate pase.

# Wave F — Backlog opcional (si queda cuerda)

Smoke test Dolt real (los 4 repos Dolt están 100% mockeados — un happy path contra Dolt local,
no necesariamente CI) · coverage de CLI commands (policy/doctor/events/hook/lint/prompt/self
están entre 0.9% y 18%) · subir los floors de coverage si la realidad subió (ratchet: nunca
bajar) · rename del ADR-014 duplicado (cosmético, cross-ref-delicado — convoy-dashboard vs
portable-workspace-operations) · PR-15 per-commit codeRefs (diferido de M3).

## Cierre de cada wave

`monsthera eval --json --k 10` (sin regresión) → knowledge note `solution` → PR con evidencia
real → work article a `done` al mergear → actualiza `MEMORY.md` del proyecto si cambia el estado
del frente abierto. Al terminar TODO: borra este archivo.
