# Consumer setup — wiring Monsthera into a downstream repo

This page is for teams who want to *use* Monsthera v3 (not develop it) from a separate repository — e.g. as an MCP server plus CLI that their agents/scripts call. If you are a Monsthera maintainer, this is not the doc you need; see `README.md` for dev setup.

The `.mcp.json` that ships in this repository is configured for Monsthera's own development (`pnpm exec tsx src/bin.ts serve`). That path JIT-compiles TypeScript on every server startup, which is fine for development but wasteful and slow for a consumer project. **Consumers should run the built `dist/bin.js`**.

---

## Prerequisites

- **Node.js 22+** (`node --version`). Monsthera's `engines.node` field enforces this.
- **pnpm 10.x** (`pnpm --version`). Other package managers work but the lockfile is pnpm-shaped, so you'll get warnings.
- **Ollama with `nomic-embed-text`** *(optional but strongly recommended)*. Without it, Monsthera falls back to BM25-only search and semantic queries return worse results. See step 4 below.
- About 500 MB of disk for the cloned repo + `node_modules` + build output.

---

## Step 1 — clone and build Monsthera

Pick a stable location you don't intend to delete. Monsthera is not published to npm yet, so the built artefacts live on disk, pointed to by your consumer repo.

```bash
cd ~/Code
git clone https://github.com/yourorg/Monsthera.git
cd Monsthera
pnpm install
pnpm build
```

After `pnpm build`, the server entrypoint is at `<your-Monsthera-path>/dist/bin.js`. Verify:

```bash
node dist/bin.js --version
# 3.0.0-alpha.7   (or whatever alpha is current)
```

Remember the absolute path — you'll paste it into your consumer repo's `.mcp.json` in step 2.

---

## Step 2 — configure `.mcp.json` in your consumer repo

In the root of the repo where you want agents to have Monsthera available, create (or edit) `.mcp.json`:

```json
{
  "mcpServers": {
    "monsthera": {
      "command": "node",
      "args": [
        "/absolute/path/to/Monsthera/dist/bin.js",
        "serve",
        "--repo",
        "/absolute/path/to/consumer-repo"
      ]
    }
  }
}
```

Notes:

- Paths must be **absolute**. `~` is not expanded, and a relative `./` is resolved relative to the client's cwd, which is usually not what you want.
- `--repo /path/to/consumer-repo` tells Monsthera where to store `.monsthera/` (its working directory) and `knowledge/` (the markdown corpus). Multiple consumer repos can share one Monsthera install, each with their own `--repo`.
- If you prefer, set `MONSTHERA_REPO` in the environment block instead of passing `--repo`. Either works; the flag wins.

Restart your MCP client (Claude Code, etc.) so it rereads `.mcp.json`. On Claude Code, you should now see `monsthera` tools (prefix `monsthera__`) in the tool list.

---

## Step 3 — sanity-check via the CLI

Before expecting MCP tools to work, confirm the same code path works via the CLI.

```bash
cd /path/to/consumer-repo
node /absolute/path/to/Monsthera/dist/bin.js status --repo . 2>/dev/null
```

You should get a JSON blob on stdout with `version`, `uptime`, `subsystems`. Every subsystem should be `healthy: true`:

```json
{
  "version": "3.0.0-alpha.7",
  "uptime": 42,
  "subsystems": [
    { "name": "storage", "healthy": true },
    { "name": "search",  "healthy": true }
  ],
  ...
}
```

If the JSON has `healthy: false` entries, check the stderr output (redirect `2>&1` instead of `2>/dev/null`) for the underlying error. Typical culprits: `--repo` pointing at a non-existent directory, or `MONSTHERA_STORAGE_DOLT_ENABLED=true` with no Dolt instance running (see `docs/dolt-local.md`).

---

## Step 4 — Semantic search (optional, local-first)

Search works out of the box with BM25 keyword matching — no external services. Adding semantic embeddings makes paraphrased queries work: a question that shares *no* keywords with the target article can still rank it. Everything runs locally via Ollama's `nomic-embed-text` model; no data leaves your machine.

**Requirements** — Ollama running, model pulled:

```bash
# install Ollama via your platform's installer (https://ollama.com)
ollama serve &                           # the daemon must be running
ollama pull nomic-embed-text             # one-time: pull the 274 MB model
```

**Enable with one command.** `self enable-semantic` honors `--repo` like every other CLI verb (defaults to cwd):

```bash
node /absolute/path/to/Monsthera/dist/bin.js self enable-semantic --repo /path/to/consumer-repo
# or, from the consumer repo itself:
cd /path/to/consumer-repo && node /absolute/path/to/Monsthera/dist/bin.js self enable-semantic
```

The command health-checks Ollama *before* changing anything (it refuses to half-enable a broken setup and prints the exact `ollama pull …` to run), persists `search.semanticEnabled=true` to `<consumer-repo>/.monsthera/config.json`, then runs a full reindex to generate embeddings for every existing article. `--json` emits a machine-readable result. Expect the reindex to take a moment on first run (one embedding call per article).

**Verify:**

```bash
node /absolute/path/to/Monsthera/dist/bin.js status --repo /path/to/consumer-repo 2>/dev/null
# search subsystem detail → "Search service (N docs, canary ok, N embeddings)"
# stats → "semanticSearchEnabled": true, "embeddingCount": N
```

When it's broken, the surfaces say so instead of pretending:

- `status` shows `semantic unavailable — run: monsthera self enable-semantic (requires Ollama)` in the search subsystem detail (semantic enabled but zero embeddings — the state you get when articles were indexed while Ollama was down).
- `monsthera doctor --repo <consumer>` has an "Embeddings" section that names the silent BM25 fallback and the exact remediation when the provider is unreachable.
- `monsthera eval` reports the engine that actually answered (`engine=bm25-fallback` when semantic is enabled but Ollama is unreachable) instead of claiming semantic was on.

**Degradation story:** without Ollama, search still works — BM25 answers every query and results are real, just ranked with keywords only. Paraphrased queries with no keyword overlap rank noticeably worse. Articles created while Ollama is up get embeddings automatically; articles indexed while it was down need a reindex (`self enable-semantic` does this, or `monsthera reindex --repo <consumer>` later) to backfill. Keeping Ollama running across reboots (launchd, login item, systemd) is your call — Monsthera only needs it reachable at index/query time.

Override the provider via env:

- `MONSTHERA_OLLAMA_URL` — default `http://localhost:11434`
- `MONSTHERA_EMBEDDING_MODEL` — default `nomic-embed-text`
- `MONSTHERA_SEMANTIC_ENABLED` — `true`/`false`, overrides the config file

---

## Step 5 — first knowledge article / work article

Write your first article via the CLI (the MCP tools have identical shape):

```bash
cd /path/to/consumer-repo
node /absolute/path/to/Monsthera/dist/bin.js knowledge create \
  --title "Onboarding note" \
  --category guide \
  --content "This is the first article in our knowledge base." \
  --tags seed,onboarding \
  --repo .
```

Verify the file landed on disk:

```bash
ls knowledge/notes/             # onboarding-note.md
cat knowledge/index.md          # the auto-maintained wiki index
```

The same for a work article:

```bash
node /absolute/path/to/Monsthera/dist/bin.js work create \
  --title "Set up Monsthera" \
  --template spike \
  --author me \
  --priority low \
  --repo .
ls knowledge/work-articles/     # w-xxxx.md
```

At this point your consumer repo has:
- `.mcp.json` pointing MCP clients at Monsthera's built server,
- `.monsthera/` (Monsthera's working dir, created on first boot),
- `knowledge/notes/*.md` and `knowledge/work-articles/*.md` (your corpus),
- `knowledge/index.md` and `knowledge/log.md` (auto-maintained navigation).

You can now add `knowledge/` to your git tracking (it's all plain markdown) while keeping `.monsthera/` in `.gitignore` (it's local state).

---

## Work tracking quickstart (wave registration)

When several agents (or several "waves" of work) run against the same repo, register each wave as a work article *before* starting it — `work list` is how the second wave discovers the first one. The work-article model and guards are [ADR-002](./adrs/002-work-article-model.md); the CLI ergonomics are [ADR-011](./adrs/011-orchestrator-cli-ergonomics.md). Every command below was run against `dist/bin.js` as written; execute from the consumer repo (`--repo` defaults to cwd).

```bash
MONSTHERA="node /absolute/path/to/Monsthera/dist/bin.js"

# 0. BEFORE starting a wave — see what is already in flight (the collision-prevention habit)
$MONSTHERA work list            # filters: --phase <p>, --wave <name> (matches tag wave-<name>), --format json

# 1. register the wave — one article per in-flight wave; prints its id (w-xxxxxxxx)
$MONSTHERA work create --title "Wave: line-D HB-037..041" --template feature \
  --author line-d-agent --tags wave-line-d

# 2. advance as the wave progresses
$MONSTHERA work advance w-xxxxxxxx --phase enrichment --reason "spec agreed; starting"

# 3. when the PR merges
$MONSTHERA work close w-xxxxxxxx --pr 51        # records canonical "merged via PR #51"
```

Guards and ladders (observed behaviour, not theory):

- Templates are `feature | bugfix | refactor | spike`, and **each template has its own phase ladder**. `feature` walks all of `planning → enrichment → implementation → review → done`; `spike` is just `planning → enrichment → done` (`implementation`/`review` are `STATE_TRANSITION_INVALID`). For lightweight research waves, `spike` is the cheapest honest registration.
- `feature` blocks `enrichment → implementation` with `GUARD_FAILED: min_enrichment_met` until its enrichment roles (`architecture`, `testing` — visible in `work get <id>`) record contributions via `work enrich <id> --role <r> --status contributed|skipped`. The audited escape is `--skip-guard-reason "<why>"` on `work advance` — the bypass and reason are recorded in phase history. Guards gate readiness, **not** ladder shape: skipping guards cannot jump phases (`work close` from `planning` fails; a `spike` closes from `enrichment` because `done` is its next rung).
- CLI errors print on **stderr** with empty stdout — with the `2>/dev/null` habit from Troubleshooting, a blocked advance is silent except for exit code 1. Check `$?`.
- `done`/`cancelled` articles are immutable — `work delete` refuses with "Cannot modify article in terminal phase". Closed waves are permanent audit records.

The MCP tools (what agents see) are named differently than the CLI verbs:

| CLI                                | MCP tool                                      |
| ---------------------------------- | --------------------------------------------- |
| `work list`                        | `list_work`                                   |
| `work create`                      | `create_work`                                 |
| `work advance --phase <p>`         | `advance_phase` (`targetPhase: <p>`)          |
| `work advance --skip-guard-reason` | `advance_phase` with `skip_guard: { reason }` |
| `work enrich`                      | `contribute_enrichment`                       |
| `work close --pr <n>`              | `advance_phase` to `done` (no close shortcut) |

---

## Step 6 — upgrading Monsthera

When a new alpha ships:

```bash
cd ~/Code/Monsthera
node dist/bin.js self status --repo /path/to/consumer-repo
node dist/bin.js self update --dry-run --repo /path/to/consumer-repo
node dist/bin.js self update --execute --repo /path/to/consumer-repo
```

No change required in the consumer repo — `.mcp.json` keeps pointing at the same `dist/bin.js`, which is now newer. Restart your MCP client once so it reloads the server.

`self update --execute` creates the workspace backup, stops managed local Dolt when needed, runs `git pull --ff-only`, installs dependencies, builds, migrates the workspace, reindexes, and restarts Dolt if it was running before the update. The backup preserves the consumer workspace (`knowledge/`, `.monsthera/config.json`, `.monsthera/manifest.json`, and `.monsthera/dolt/`) under `.monsthera/backups/` before the executable changes. If a migration goes wrong, restore explicitly:

```bash
node dist/bin.js workspace restore /path/to/consumer-repo/.monsthera/backups/<backup-id> \
  --repo /path/to/consumer-repo \
  --force
```

If Monsthera's frontmatter schema changed and your old articles need a migration, `monsthera doctor --repo /path/to/consumer-repo` will list legacy articles and offer `--fix-stale-code-refs` / `--archive-legacy` / `--seed-current-docs` remediation flags.

---

## Troubleshooting

- **MCP client doesn't see `monsthera__` tools.** Restart the client. Check the client's MCP log for a spawn error; the most common issue is a wrong absolute path in `.mcp.json`.
- **CLI works but MCP tools error with `PERMISSION_DENIED` / `STORAGE_FAILED`.** The MCP server runs in the client's working directory; if `--repo` is omitted, it defaults to the MCP client's cwd, not yours. Pass `--repo` explicitly.
- **Search results ignore paraphrases / `status` says `semantic unavailable`.** Embeddings were never generated (typically: Ollama wasn't running when articles were indexed). Start Ollama, then run `monsthera self enable-semantic --repo <consumer>` (step 4) — it verifies the provider and reindexes.
- **`JSON.parse` fails on the CLI output.** You're probably capturing both stdout and stderr. Monsthera routes structured logs to stderr (see `docs/concurrency-model.md` — er, the `tests/integration/cli-stream-separation.test.ts` regression test — for the contract). Use `2>/dev/null` when piping.

---

## See also

- [Migration from v2](./migration-from-v2.md) — if you're arriving with v2 prompts.
- [Concurrency model](./concurrency-model.md) — single-writer-per-article limits.
- [ADR-002 — Work article model](./adrs/002-work-article-model.md) — the v3 design rationale.
