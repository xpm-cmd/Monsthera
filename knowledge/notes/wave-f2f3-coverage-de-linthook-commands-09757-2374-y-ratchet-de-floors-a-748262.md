---
id: k-jvccuix2
title: Wave F2+F3: coverage de lint/hook commands (0.97%→57%, 2.3%→74%) y ratchet de floors a 74/82/62
slug: wave-f2f3-coverage-de-linthook-commands-09757-2374-y-ratchet-de-floors-a-748262
category: solution
tags: [wave-f, cli, coverage, testing, ratchet]
codeRefs: [tests/unit/cli/lint-hook-commands.test.ts, vitest.config.ts, src/cli/lint-commands.ts, src/cli/hook-commands.ts]
references: [k-3zo9w9dg, k-5xnflq1k]
createdAt: 2026-06-11T05:53:50.357Z
updatedAt: 2026-06-11T05:53:50.357Z
---

Rama `test/f2-cli-coverage` desde main post-#169. F2+F3 del backlog opcional.

## F2 — behavior-pinning de los dos peores archivos CLI

15 tests sobre `handleLint` / `handleInstallHook` / `handleUninstallHook`: superficies de help, TODOS los exit paths de validación de flags, el split NDJSON/text, la semántica warning-vs-error del exit code (orphan_citation = warning, exit 0), y el contrato del marker `monsthera-managed-hook` (install, rechazo de hook ajeno + --overwrite, refresh silencioso, uninstall solo borra archivos con marker).

**Dos detalles de arnés reutilizables:**
1. `process.exit` mockeado para LANZAR (`ExitSignal` con code assertable), no como no-op — estos comandos siguen ejecutando tras un exit de validación; un no-op correría paths que el CLI real jamás alcanza (install-hook habría sobreescrito el hook ajeno EN EL TEST).
2. Pinning corre contra la realidad: una aserción mía se corrigió por el output real (el formatter text imprime "orphan citation" con espacio, no el rule id).

## F3 — ratchet

Cobertura real post-F2: lines 74.34 / functions 83.13 / branches 62.96 (lint-commands 0.97→57.3%, hook-commands 2.29→73.6%). Floors 72/80/61 → **74/82/62** (at-or-just-below; el ratchet jamás baja). Gate verificado con los floors nuevos mordiendo.

## Verificación

15/15 nuevos · suite completa 2337 (+15) · gate completo verde con floors nuevos.