---
id: w-zxi617cw
title: Simplificar instalación, actualización y portabilidad del workspace
template: feature
phase: planning
priority: high
author: codex
tags: [workspace, self-update, process-registry, dolt, portability]
references: [k-acodv9lb, k-8dsb3up8, k-rksv8m51, k-2njgnd6v]
codeRefs: [src/cli/main.ts, src/cli/workspace-commands.ts, src/cli/self-commands.ts, src/workspace/manifest.ts, src/workspace/service.ts, src/ops/process-registry.ts, src/ops/self-service.ts, scripts/dolt/start-local.sh, scripts/dolt/stop-local.sh, tests/unit/workspace/service.test.ts, tests/unit/ops/process-registry.test.ts, tests/unit/ops/self-service.test.ts, tests/unit/cli/main.test.ts, docs/adrs/014-portable-workspace-operations.md, README.md, docs/consumer-setup.md, docs/dolt-local.md]
dependencies: []
blockedBy: []
createdAt: 2026-04-26T04:51:35.550Z
updatedAt: 2026-04-26T10:46:40.915Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"codex","status":"pending"},{"role":"testing","agentId":"codex","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T04:51:35.550Z"}]}
lead: codex
---

## Objetivo
Crear una superficie operacional oficial para Monsthera que haga instalación, actualización, reinicio, backup, restauración y migración de workspaces de forma idempotente y segura.

## Fase 1 completada
- Agregado `workspace status|migrate|backup|restore`.
- Agregado manifiesto portable `.monsthera/manifest.json` con schema de workspace independiente de la versión del paquete.
- Backups incluyen `knowledge/`, `.monsthera/config.json`, `.monsthera/manifest.json` y `.monsthera/dolt/`; `.monsthera/run/` sigue siendo efímero.
- Documentado en README, consumer setup, Dolt local guide y ADR-014.
- PR #89 mergeado a `main` como `103f3b9`.

## Fase 2 en progreso
- Agregado registro de procesos gestionados en `.monsthera/run/*.json`, con compatibilidad transicional para `.pid` legado.
- Scripts Dolt ahora escriben metadata JSON al iniciar en daemon y validan comando antes de detener procesos.
- Agregado `self status`, `self update --dry-run`, `self update --prepare`, `self update --execute` y `self restart dolt`.
- `self update --execute` está protegido por blockers: instalación no-git, working tree sucio, schema de workspace más nuevo que el binario, o Dolt corriendo con metadata no confiable.
- La ejecución hace backup, detiene Dolt gestionado si estaba corriendo, `git pull --ff-only`, `pnpm install --frozen-lockfile`, `pnpm build`, `workspace migrate`, `reindex`, reinicia Dolt si estaba arriba y deja indicado que el cliente MCP stdio debe reiniciarse manualmente.

## Validación local
- `pnpm vitest run tests/unit/ops/process-registry.test.ts tests/unit/ops/self-service.test.ts tests/unit/workspace/service.test.ts tests/unit/cli/main.test.ts` pasó: 69 tests.
- `pnpm typecheck` pasó.
- `pnpm lint` pasó.
- `bash -n scripts/dolt/start-local.sh scripts/dolt/stop-local.sh` pasó.
- `pnpm build` pasó.
- Prueba manual: `self status --json`, `self update --dry-run` y `self --help` funcionan; el dry-run bloquea correctamente en la rama sucia actual y detecta Dolt legado no confiable.

## Próximos pendientes
- Commit/PR de fase 2.
- Una fase posterior puede ampliar gestión a dashboard u otros procesos y agregar rollback automático sobre fallos posteriores al backup.