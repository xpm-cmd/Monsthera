---
id: k-w9r21jkj
title: Wave B2: "When to use" en las 69 tool descriptions MCP — schemas byte-idénticos
slug: wave-b2-when-to-use-en-las-69-tool-descriptions-mcp-schemas-byte-idnticos
category: solution
tags: [wave-b, dx, mcp-tools, tool-descriptions, agent-ux]
codeRefs: [src/tools/knowledge-tools.ts, src/tools/work-tools.ts, src/tools/search-tools.ts, src/tools/code-intelligence-tools.ts]
references: [k-3zo9w9dg]
createdAt: 2026-06-10T12:12:54.436Z
updatedAt: 2026-06-10T12:12:54.436Z
---

Wave B2 (auditoría P3). Rama `chore/b2-tool-descriptions-when-to-use`, apilada sobre #154. Las 69 tool descriptions describían QUÉ hace cada tool pero no CUÁNDO usarlo — los agentes eligen por situación, no por mecánica.

## Qué cambió

Cada description top-level termina ahora con una oración `When to use: …` centrada en gatillos y **contraste cross-tool** (el contenido de mayor valor):

- Escalera de code-refs: `code_find_owners` → `code_get_ref` → `code_analyze_impact` (+ `code_detect_changes` como path batch).
- Profundidad de retrieval: `search` (existencia/ids) vs `think` (respuesta sintetizada con citas) vs `build_context_pack` (apertura de tarea).
- `refs_orphans` (targets rotos) vs `refs_stale` (edad/drift) · `events_emit` (lifecycle estricto del harness) vs `log_event` (provenance general) · ciclo `session_open/brief/close` · `index_article` (un artículo) vs `reindex_all` (drift masivo) · get vs batch_get por volumen.

## Cómo se garantizó "solo descriptions" (patrón reutilizable)

Arnés de verificación por **import real, no regex**: script tsx que importa las 18 funciones `*ToolDefinitions()`, vuelca `{name → inputSchema}` ordenado y lo diffea before/after → **byte-idéntico (diff exit 0)**. Conteo `{total: 69, withWhen: 69}` por el mismo script. Ejecución delegada a 2 agentes en paralelo sobre archivos disjuntos con spec estricta (append-only, formato del string preservado); pasada de calidad propia sobre el diff.

Bonus: comment desactualizado "Returns the 9 knowledge tool definitions" (la función devuelve 10) → sin conteo hardcodeado.

## Verificación

Schemas byte-idénticos · 69/69 con When to use · tests que pinean substrings de descriptions intactos y verdes · gate completo (typecheck 0 · eslint 0 · coverage exit 0 con 2305 tests · corpus lint 0 · audit high 0).