# ADR-014: Portable Workspace Operations

## Status

Accepted — 2026-04-26

## Context

Monsthera's executable code changes often, while a user's corpus and local runtime state must survive those updates. The repo already separates Markdown source of truth from Dolt-backed derived/audit data, but installation and upgrade steps were still manual: pull code, install dependencies, build, restart Dolt, restart the MCP client, and reindex.

That made updates fragile because process state, generated data, and durable workspace data were handled by the same operator runbook.

## Decision

Monsthera treats the workspace as a portable, versioned unit that is distinct from the installed executable.

The workspace has three layers:

- **Portable source data:** `knowledge/`, `.monsthera/config.json`, `.monsthera/manifest.json`.
- **Portable local database data:** `.monsthera/dolt/`, including derived search data and non-derived audit/snapshot data.
- **Ephemeral runtime data:** `.monsthera/run/`, transient logs, process ids, and rebuildable caches.

The workspace version is stored in `.monsthera/manifest.json` and is independent from `package.json` versioning. Code updates may replace Monsthera's executable, but data format changes must go through explicit workspace migrations.

## Initial Implementation

The first operational slice adds:

- `monsthera workspace status` — inspect schema compatibility and portable paths.
- `monsthera workspace migrate` — create or update `.monsthera/manifest.json`.
- `monsthera workspace backup` — copy portable workspace data into `.monsthera/backups/<backup-id>/`.
- `monsthera workspace restore <backup-path> --force` — restore a backup after an explicit overwrite flag.

Backups include:

- `knowledge/`
- `.monsthera/config.json`
- `.monsthera/manifest.json`
- `.monsthera/dolt/`
- `backup-manifest.json`

Missing paths are recorded as skipped instead of causing failure. Restore is intentionally gated by `--force` because it overwrites local workspace files.

## Consequences

`monsthera self update` can now be built as a thin operational workflow on top of workspace backup/migrate/health checks. It should not mutate workspace data directly except through the workspace service.

PID files and process control remain a follow-up. They should use metadata JSON and validate command/cwd before stopping a process.
