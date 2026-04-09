# Local Dolt Guide

Monsthera v3 can already use Dolt in hybrid mode:

- Markdown stays the source of truth for `knowledge/`
- Dolt stores the structured search index
- Dolt stores orchestration events

This repo includes local scripts so you can run Dolt without Docker.

## 1. Install Dolt locally

```bash
pnpm dolt:install
```

This downloads the Dolt CLI into `.monsthera/bin/dolt`.

## 2. Start a local SQL server

Foreground:

```bash
pnpm dolt:start
```

Daemon mode:

```bash
pnpm dolt:start:daemon
```

Daemon mode writes:

- PID: `.monsthera/run/dolt.pid`
- Log: `.monsthera/run/dolt.log`

Stop it with:

```bash
pnpm dolt:stop
```

## 3. Run Monsthera against Dolt

The current runtime uses Dolt for search index and orchestration events.

```bash
MONSTHERA_DOLT_ENABLED=true \
MONSTHERA_DOLT_HOST=127.0.0.1 \
MONSTHERA_DOLT_PORT=3306 \
MONSTHERA_DOLT_DATABASE=monsthera \
pnpm exec tsx src/bin.ts status
```

You can use the same environment when running:

```bash
MONSTHERA_DOLT_ENABLED=true pnpm dev
MONSTHERA_DOLT_ENABLED=true pnpm dashboard
MONSTHERA_DOLT_ENABLED=true pnpm exec tsx src/bin.ts reindex
pnpm demo:smoke
```

## 4. Optional environment variables

These are now supported by the v3 config loader:

- `MONSTHERA_DOLT_ENABLED`
- `MONSTHERA_DOLT_HOST`
- `MONSTHERA_DOLT_PORT`
- `MONSTHERA_DOLT_DATABASE`
- `MONSTHERA_DOLT_USER`
- `MONSTHERA_DOLT_PASSWORD`

Defaults:

- host: `localhost`
- port: `3306`
- database: `monsthera`
- user: `root`
- password: empty

## 5. Local data layout

The helper script creates a local Dolt data dir at:

```text
.monsthera/dolt/
```

And initializes a database directory named after `MONSTHERA_DOLT_DATABASE`.

## Notes

- The first launch initializes the Dolt database directory automatically.
- The local helper uses `127.0.0.1` by default to match the Node/mysql2 client path cleanly.
- If Dolt is unavailable, Monsthera falls back to in-memory derived storage.
