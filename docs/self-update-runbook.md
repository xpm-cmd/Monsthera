# Self update runbook

This runbook covers the day-to-day operations for keeping a Monsthera install
healthy and up to date: install, update, rollback, repair, restart, and
restore.

All commands assume the current working directory is the workspace repo
(`monsthera ...` or `pnpm exec tsx src/bin.ts ...` from the install checkout).

## Mental model

A Monsthera install has three layers (see ADR-014 for the canonical design):

- **Install checkout** — the cloned git repository with `node_modules/` and
  `dist/`. Updated by `git pull` + `pnpm install` + `pnpm build`.
- **Portable workspace** — `.monsthera/manifest.json`,
  `.monsthera/config.json`, `knowledge/`, and `.monsthera/dolt/`. Survives
  upgrades and is the unit captured by `workspace backup`.
- **Ephemeral runtime** — `.monsthera/run/` and `.monsthera/cache/`. Process
  metadata (`<kind>.json`) and PID files live here. They never go in backups.

Self operations work on top of these layers and are designed to be safe to
re-run.

## Day 0 — Install

```bash
# Clone the install checkout where Monsthera will live.
git clone https://github.com/xpm-cmd/Monsthera.git ~/Projects/Monsthera
cd ~/Projects/Monsthera

# Install dependencies and build the binary.
pnpm install
pnpm build

# Initialise the workspace (creates .monsthera/manifest.json on first run).
pnpm exec monsthera workspace migrate

# Verify everything is healthy.
pnpm exec monsthera self doctor
```

The first `self doctor` run on a fresh install should report `Healthy: yes`.
If `dolt` is not installed yet, see `docs/dolt-local.md`.

## Day-to-day — Status

```bash
# Human-readable summary.
monsthera self status

# Machine-readable form for scripts and dashboards.
monsthera self status --json
```

Inspect:

- **Install** — git checkout path, branch, HEAD, upstream, dirty flag.
- **Workspace** — schema, manifest path, knowledge root, dolt data dir,
  backup root.
- **Managed processes** — Dolt PID, running flag, trust flag, source
  (`json` / `legacy-pid` / `missing`).

A trusted process means the JSON metadata at `.monsthera/run/<kind>.json`
matches the actual command running under that PID. Untrusted means either
the metadata is absent, malformed, or `ps` reports a different command.

## Update — Safe path

The update flow is: dry-run → prepare → execute. Each step adds more
side effects; you can stop at any of them.

### 1. Dry-run

```bash
monsthera self update --dry-run
```

Prints the exact step sequence and any blockers. Blockers are:

- `installation is not a git checkout`
- `installation working tree is dirty`
- `workspace schema is newer than this Monsthera version`
- `Dolt process is running but metadata is not trusted`

If the dry-run reports blockers, fix them first (`self doctor --fix`,
`git stash`, etc.) before continuing.

### 2. Prepare (optional)

```bash
monsthera self update --prepare
```

Creates a workspace backup under `.monsthera/backups/<backup-id>/` and
ensures the manifest is up to date, then prints the plan. Use this when you
want a safety checkpoint before a maintenance window.

### 3. Execute

```bash
monsthera self update --execute
```

Runs the guarded plan end to end:

1. Workspace backup (`.monsthera/backups/<backup-id>/`).
2. Stop managed Dolt if it was running.
3. `git pull --ff-only` in the install checkout.
4. `pnpm install --frozen-lockfile`.
5. `pnpm build`.
6. `workspace migrate`.
7. `reindex` (via the freshly-built `dist/bin.js`).
8. Restart Dolt if it was running before the update.
9. Print a reminder to restart any stdio MCP clients.

If any step after the backup fails, `self update --execute` triggers an
**automatic rollback** (see next section). Stdio MCP clients must always be
restarted manually after the binary changes.

## Automatic rollback

If a step fails after the workspace backup completes, the executor:

1. Restores the workspace from the backup (`knowledge/`,
   `.monsthera/config.json`, `.monsthera/manifest.json`,
   `.monsthera/dolt/`).
2. If Dolt was running before the update, attempts to restart it.
3. Returns a `StorageError` whose `details.rollback` field describes the
   restore: `{ performed, backupPath, restored, skipped, doltRestarted, errors }`.

The rollback does **not** undo the `git pull` or rebuild steps. The install
checkout may end up at the new HEAD with broken dependencies. The expected
recovery is:

```bash
# Inspect what failed.
monsthera self update --execute --json | jq .

# Either re-run after addressing the cause, e.g. clearing pnpm cache:
pnpm install --frozen-lockfile
monsthera self update --execute

# Or roll the install back manually if the new commit is the problem:
cd <install-path>
git reset --hard ORIG_HEAD
pnpm install --frozen-lockfile
pnpm build
```

The user's data is safe because the workspace was restored before the
command returned.

## Repair — `self doctor`

`self doctor` is a non-destructive diagnostic. It surfaces:

- Install integrity issues (not a git checkout, dirty working tree).
- Workspace issues (missing manifest, future schema).
- Dolt process metadata issues (legacy `.pid` files, stale JSON metadata,
  untrusted commands).

```bash
# Diagnose only.
monsthera self doctor

# Apply safe fixes.
monsthera self doctor --fix
```

Fixes that `--fix` will perform automatically:

- **Missing workspace manifest** — runs `workspace migrate` to create it.
- **Legacy `<kind>.pid` with a live process** — adopts the PID into trusted
  JSON metadata by inferring the command via `ps`, then removes the
  `.pid` file. The process keeps running.
- **Stale JSON metadata for a dead process** — removes
  `.monsthera/run/<kind>.json` so `self restart` can start the daemon
  cleanly.

Doctor exits with status code `2` if any blocker remains.

## Restart Dolt

```bash
# Refuses to stop an untrusted process unless --force is passed.
monsthera self restart dolt

# Force a stop even when metadata is untrusted (use after self doctor).
monsthera self restart dolt --force
```

Behind the scenes this calls `stop-local.sh`, removes process files, and
starts the daemon via `start-local.sh --daemon`. The new daemon writes
trusted JSON metadata.

## Restore from a backup

If a `self update --execute` rollback fails (rare — usually a permissions
issue) or you need to revert to an older snapshot, restore manually:

```bash
ls .monsthera/backups/
monsthera workspace restore .monsthera/backups/<backup-id> --force
```

`--force` is required because restore overwrites portable workspace files.

## Troubleshooting matrix

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `self update --dry-run` reports `working tree is dirty` | Local edits in install checkout | `git stash` or commit, then retry |
| Doctor reports `dolt.legacy-pid` | Dolt was started by an older Monsthera | `self doctor --fix` |
| Doctor reports `dolt.untrusted` | Dolt running with a command that doesn't match metadata | Stop Dolt manually (`kill <pid>`), remove `.monsthera/run/dolt.json`, run `self restart dolt` |
| `self update --execute` fails on `pnpm build` | Build broken on new HEAD | Fix or roll back HEAD; data is already restored from backup |
| `workspace.schema-future` blocker | Workspace was opened by a newer Monsthera | Upgrade Monsthera or restore an older backup |

## Related references

- ADR-014: `docs/adrs/014-portable-workspace-operations.md`
- ADR-016: `docs/adrs/016-self-update-rollback-and-doctor.md`
- Dolt local: `docs/dolt-local.md`
- Consumer setup: `docs/consumer-setup.md`
