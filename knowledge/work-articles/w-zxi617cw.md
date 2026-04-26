---
id: w-zxi617cw
title: Simplificar instalación, actualización y portabilidad del workspace
template: feature
phase: planning
priority: high
author: codex
tags: [workspace, self-update, process-registry, dolt, portability]
references: [k-acodv9lb, k-8dsb3up8, k-rksv8m51, k-2njgnd6v]
codeRefs: [src/cli/main.ts, src/cli/workspace-commands.ts, src/cli/self-commands.ts, src/workspace/manifest.ts, src/workspace/service.ts, src/ops/process-registry.ts, src/ops/self-service.ts, src/ops/command-runner.ts, src/ops/doctor.ts, scripts/dolt/start-local.sh, scripts/dolt/stop-local.sh, tests/unit/workspace/service.test.ts, tests/unit/ops/process-registry.test.ts, tests/unit/ops/process-registry-adopt.test.ts, tests/unit/ops/self-service.test.ts, tests/unit/ops/self-service-update.test.ts, tests/unit/ops/doctor.test.ts, tests/unit/cli/main.test.ts, docs/adrs/014-portable-workspace-operations.md, docs/adrs/016-self-update-rollback-and-doctor.md, docs/self-update-runbook.md, README.md, docs/consumer-setup.md, docs/dolt-local.md]
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

## Fase 3 en progreso (rama `codex/self-update-rollback`)
- Extraído `CommandRunner` inyectable en `src/ops/command-runner.ts`. `inspectSelf`, `planSelfUpdate`, `restartDolt` y `executeSelfUpdate` aceptan un runner opcional; producción usa `realCommandRunner`. Esto habilita tests del update sin invocar `git pull`/`pnpm install`/`pnpm build` reales.
- `executeSelfUpdate` ahora hace **rollback automático** cuando un paso falla después del backup: restaura el workspace con `restoreWorkspace(..., force: true)` y reinicia Dolt si estaba corriendo. El error retornado lleva la estructura de rollback en `details.rollback` (`performed`, `backupPath`, `restored`, `skipped`, `doltRestarted`, `errors`). El git pull no se rebobina, por diseño.
- Agregado `adoptLegacyPidFile(repoPath, kind)`: promueve un `<kind>.pid` legado a metadata JSON confiable infiriendo el comando vía `ps`, y borra el `.pid`. Si el proceso está muerto, también borra el `.pid` legado y devuelve `ValidationError`.
- Agregado `cleanupStaleMetadata(repoPath, kind)`: borra `<kind>.json` cuando apunta a un proceso muerto.
- Nuevo comando `monsthera self doctor [--fix] [--json]` en `src/ops/doctor.ts` + `src/cli/self-commands.ts`. Reporta findings clasificados (`blocker` / `warning` / `info`) con hints. Con `--fix` aplica:
  - workspace.no-manifest → `migrateWorkspace`.
  - dolt.legacy-pid → `adoptLegacyPidFile`.
  - dolt.stale-metadata → `cleanupStaleMetadata`.
  - blockers como `install.dirty` o `dolt.untrusted` quedan en blocker (no auto-fix); doctor sale con código 2 si hay blockers.
- CLI de `self update --execute` ahora imprime el reporte de rollback en stderr cuando falla.
- Documentación: `docs/self-update-runbook.md` (runbook completo: install / status / dry-run / prepare / execute / rollback / doctor / restart / restore / troubleshooting matrix) y ADR-016 `docs/adrs/016-self-update-rollback-and-doctor.md`.

## Validación local fase 3
- `pnpm vitest run tests/unit/ops/command-runner.test.ts tests/unit/ops/doctor.test.ts tests/unit/ops/process-registry-adopt.test.ts tests/unit/ops/process-registry.test.ts tests/unit/ops/self-service-update.test.ts tests/unit/ops/self-service.test.ts tests/unit/workspace/service.test.ts tests/unit/cli/main.test.ts` (ver bloque de validación final del PR).
- `pnpm typecheck` limpio tras cada paso del refactor.
- Smoke local: `self status --json`, `self update --dry-run`, `self doctor` reportan estado consistente sobre la rama actual.

## Pendientes posteriores
- Procesos gestionados adicionales (dashboard) — el `kind` del registry ya admite `"dashboard"`, falta cablear scripts/start-stop equivalentes a Dolt.
- `self update --execute` podría ofrecer un flag `--allow-dirty` controlado para entornos CI donde el dirty es esperado.
- Reverso opcional del git pull (`--reset-on-failure`) detrás de un flag explícito si la comunidad lo pide.