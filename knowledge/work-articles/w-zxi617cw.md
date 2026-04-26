---
id: w-zxi617cw
title: Simplificar instalación, actualización y portabilidad del workspace
template: feature
phase: planning
priority: high
author: codex
tags: [ops, install, upgrade, workspace, dolt, portability]
references: [k-acodv9lb, k-8dsb3up8, k-rksv8m51, k-2njgnd6v]
codeRefs: [src/cli/main.ts, src/cli/workspace-commands.ts, src/workspace/manifest.ts, src/workspace/service.ts, tests/unit/workspace/service.test.ts, tests/unit/cli/main.test.ts, docs/adrs/014-portable-workspace-operations.md, README.md, docs/consumer-setup.md, docs/dolt-local.md, src/core/config.ts, src/core/container.ts, src/persistence/schema.ts, scripts/dolt/start-local.sh, scripts/dolt/stop-local.sh, scripts/dolt/install-local.sh]
dependencies: []
blockedBy: []
createdAt: 2026-04-26T04:51:35.550Z
updatedAt: 2026-04-26T04:57:37.138Z
enrichmentRolesJson: {"items":[{"role":"architecture","agentId":"codex","status":"pending"},{"role":"testing","agentId":"codex","status":"pending"}]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-26T04:51:35.550Z"}]}
lead: codex
---

## Objective

Diseñar e implementar una capa operacional oficial para Monsthera que haga instalación, actualización, reinicio, backup, restauración y migración de workspaces de forma idempotente y segura.

El principio central es separar el ejecutable de Monsthera del workspace portable del usuario. Actualizar Monsthera debe poder reemplazar código y dist sin destruir `knowledge/`, `.monsthera/config.json`, `.monsthera/dolt/`, eventos, snapshots ni otros datos persistentes.

## Acceptance Criteria

- Existe un modelo documentado de tres capas: instalación, workspace portable y runtime efímero.
- Existe un `manifest.json` de workspace con versión de schema, rutas portables y metadatos de compatibilidad.
- `monsthera self status` reporta versión local/remota, commit local/remoto, estado de Dolt, procesos gestionados, rutas de workspace y compatibilidad de schema.
- `monsthera self update` actualiza el código desde git checkout, detiene procesos gestionados, crea backup previo, instala dependencias, reconstruye `dist`, ejecuta migraciones necesarias, reindexa y verifica salud.
- `monsthera workspace backup` crea un backup portable de `knowledge/`, `.monsthera/config.json`, `.monsthera/dolt/` y `manifest.json` con Dolt detenido o bloqueado correctamente.
- `monsthera workspace restore <backup>` restaura un backup y valida salud antes de declarar éxito.
- `monsthera workspace migrate` aplica migraciones versionadas y auditables de workspace sin mezclar migraciones de código con migraciones de datos.
- Los PID files pasan de texto plano a metadata JSON y validan command/cwd antes de matar procesos.
- El upgrade nunca borra Dolt automáticamente; si hay datos derivados regenerables, se limpian solo por migración explícita o reindex.
- La documentación de consumidor cambia de pasos manuales (`git pull`, `pnpm install`, `pnpm build`) a comandos oficiales `self` y `workspace`.
- Hay pruebas unitarias para detección de manifest, backup/restore path planning, migración de schema y validación segura de PIDs.
- Hay al menos una prueba de integración para `self status` y una para el flujo feliz de backup + migrate + restore en un repo temporal.

## Implementation Progress

First slice completed on 2026-04-26:

- Added `WorkspaceManifest` with `workspaceSchemaVersion`, `createdBy`, `lastOpenedBy`, portable paths, and timestamps.
- Added workspace service operations for `status`, `migrate`, `backup`, and `restore`.
- Added CLI adapter: `monsthera workspace status|migrate|backup|restore` with `--json`; restore requires `--force`.
- Added ADR-014 documenting portable workspace operations.
- Updated README, Dolt guide, and consumer setup upgrade flow to use workspace backup/migrate.
- Added focused unit coverage for service behavior and CLI routing.

Deferred to next slice:

- `monsthera self status|update|restart`.
- Managed process registry/PID JSON for Dolt/dashboard.
- Health validation after restore.
- Export/import archive format beyond directory backups.

## Proposed Plan

### Phase 1: ADR and contracts

- Escribir ADR: "Operational install/update and portable workspace model".
- Definir qué es persistente, derivado y efímero.
- Definir garantías: backup antes de migrar, migraciones idempotentes, no destrucción silenciosa, rollback manual claro.

### Phase 2: Workspace manifest

- Añadir `WorkspaceManifest` y loader/writer bajo `src/core` o `src/workspace`.
- Crear `.monsthera/manifest.json` si no existe.
- Versionar `workspaceSchemaVersion` independiente de `package.json`.

### Phase 3: Process registry

- Reemplazar PID text file de Dolt por JSON metadata.
- Añadir funciones de lectura, validación y terminación segura.
- Mantener compatibilidad con el PID text file legado durante una versión.

### Phase 4: Workspace commands

- Añadir `monsthera workspace status|backup|restore|migrate|export|import`.
- Backup debe preservar paths relativos para portabilidad entre máquinas.
- Restore debe exigir confirmación/flag si pisa un workspace existente.

### Phase 5: Self commands

- Añadir `monsthera self status|update|restart`.
- Primera versión soporta instalación desde git checkout.
- `self update` no mata MCP stdio no gestionado; detecta y reporta procesos externos.

### Phase 6: Docs and integration

- Actualizar `docs/consumer-setup.md`, `docs/dolt-local.md` y README.
- Recomendar una ruta estable para MCP en vez de `pnpm exec tsx src/bin.ts serve` para consumidores.
- Agregar runbook de rollback.

## Open Questions

- ¿El instalador oficial debe vivir como shell script en `scripts/install.sh`, como paquete npm global, o ambos?
- ¿Queremos soportar actualización desde npm además de git checkout en la primera iteración?
- ¿Eventos/snapshots en Dolt deben exportarse también a JSON durante backup para facilitar restore sin Dolt?
- ¿El dashboard debería exponer botones para backup/update o mantenerlo CLI-only por ahora?
