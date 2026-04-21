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

## Step 4 — enable Ollama (recommended)

Monsthera's `build_context_pack` and `search` tools use semantic embeddings via Ollama's `nomic-embed-text` model. Without it, search degrades to BM25 only.

```bash
# install Ollama via your platform's installer (https://ollama.com)
ollama serve &                           # start the local daemon
ollama pull nomic-embed-text             # pull the 274 MB model
curl http://localhost:11434/api/tags \
  | grep -o '"name":"nomic-embed-text[^"]*"'
# "name":"nomic-embed-text:latest"
```

If `curl` prints the model name, Monsthera will pick it up on next container boot. No config change required — the default `MonstheraConfig` points at `http://localhost:11434` with model `nomic-embed-text`. Override via env:

- `MONSTHERA_EMBEDDING_URL` — default `http://localhost:11434`
- `MONSTHERA_EMBEDDING_MODEL` — default `nomic-embed-text`

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

## Step 6 — upgrading Monsthera

When a new alpha ships:

```bash
cd ~/Code/Monsthera
git pull
pnpm install
pnpm build
```

No change required in the consumer repo — `.mcp.json` keeps pointing at the same `dist/bin.js`, which is now newer. Restart your MCP client once so it reloads the server.

If Monsthera's frontmatter schema changed and your old articles need a migration, `monsthera doctor --repo /path/to/consumer-repo` will list legacy articles and offer `--fix-stale-code-refs` / `--archive-legacy` / `--seed-current-docs` remediation flags.

---

## Troubleshooting

- **MCP client doesn't see `monsthera__` tools.** Restart the client. Check the client's MCP log for a spawn error; the most common issue is a wrong absolute path in `.mcp.json`.
- **CLI works but MCP tools error with `PERMISSION_DENIED` / `STORAGE_FAILED`.** The MCP server runs in the client's working directory; if `--repo` is omitted, it defaults to the MCP client's cwd, not yours. Pass `--repo` explicitly.
- **Semantic search returns worse-than-BM25 results.** Almost always Ollama isn't reachable. Run the `curl` check from step 4.
- **`JSON.parse` fails on the CLI output.** You're probably capturing both stdout and stderr. Monsthera routes structured logs to stderr (see `docs/concurrency-model.md` — er, the `tests/integration/cli-stream-separation.test.ts` regression test — for the contract). Use `2>/dev/null` when piping.

---

## See also

- [Migration from v2](./migration-from-v2.md) — if you're arriving with v2 prompts.
- [Concurrency model](./concurrency-model.md) — single-writer-per-article limits.
- [ADR-002 — Work article model](./adrs/002-work-article-model.md) — the v3 design rationale.
