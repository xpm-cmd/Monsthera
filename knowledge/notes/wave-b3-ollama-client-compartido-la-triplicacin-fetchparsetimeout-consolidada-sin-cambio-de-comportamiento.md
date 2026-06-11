---
id: k-e86w9l9u
title: Wave B3: ollama-client compartido — la triplicación fetch+parse+timeout consolidada sin cambio de comportamiento
slug: wave-b3-ollama-client-compartido-la-triplicacin-fetchparsetimeout-consolidada-sin-cambio-de-comportamiento
category: solution
tags: [wave-b, refactor, ollama, consolidation, core]
codeRefs: [src/core/ollama-client.ts, src/search/embedding.ts, src/sessions/llm-summarizer.ts, src/core/text-generator.ts, tests/unit/core/ollama-client.test.ts]
references: [k-3zo9w9dg]
createdAt: 2026-06-10T12:18:37.998Z
updatedAt: 2026-06-10T12:18:37.998Z
---

Wave B3 (auditoría P3). Rama `refactor/b3-ollama-client`, apilada sobre #155.

## Diseño: mensajes del caller, semántica explícita

`ollamaRequest(spec)` en `src/core/ollama-client.ts` — un primitivo JSON-over-HTTP que devuelve `Result`. Las claves del "cero cambio de comportamiento":

- **Mensajes de error suministrados por el caller** (`statusErrorMessage` → `"X (status)"`, `transportErrorMessage` → `{cause}`): cada call-site conserva su texto EXACTO pre-consolidación, que los tests de consumidores pinean por substring.
- **`timeoutMs` AUSENTE = sin AbortSignal en absoluto** — el path de embedding deliberadamente no tiene timeout (reindex masivo es lento); un default de timeout habría sido un cambio de comportamiento silencioso.
- **`parse: "none"`** para healthChecks de reachability (no leen el body) · **`includeBodyDetail`** reproduce el shape de detalle de generate/embed (status+body) vs healthChecks (solo status).
- `normalizeOllamaBaseUrl()` reemplaza 3 copias del strip de trailing-slash.

## Única diferencia deliberada (divulgada)

`OllamaEmbeddingProvider.healthCheck` parseaba el JSON de tags FUERA de su try/catch — un 200 con body no-JSON lanzaba excepción en vez de Result. Ahora degrada a error limpio como todos los demás paths. Estrictamente más robusto; divulgado en el PR.

## Verificación

TDD 7-red→green sobre el primitivo (incluye: signal presente solo con timeoutMs; parse none no lee body; shapes de detalle). **Los 5 suites de consumidores (embedding, ollama-embedding, llm-summarizer, text-generator, container-wiring) pasan con CERO aserciones tocadas — 57/57.** `grep "await fetch("` = 0 en embedding/summarizer; los 2 restantes en text-generator son `OpenAITextGenerator` (auth/headers distintos, fuera de alcance). Gate completo: typecheck 0 · eslint 0 · coverage exit 0 (2312 tests) · corpus lint 0 · audit high 0.