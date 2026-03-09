<p align="center">
  <strong>&#9670; Agora</strong>
</p>

<p align="center">
  Local, commit-scoped shared context and multi-agent coordination for co-coding.
</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#tools">Tools</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#dashboard">Dashboard</a> &middot;
  <a href="LICENSE">MIT License</a>
</p>

---

Agora is an [MCP server](https://modelcontextprotocol.io/) that gives AI coding agents a shared brain.
It indexes your repository with Git-aware parsing, provides hybrid semantic search,
coordinates multiple agents through trust-enforced tools, and persists knowledge across sessions.

Everything runs locally. No cloud. No API keys. One binary, zero runtime config.

## Features

- **Git-aware indexing** &mdash; Tree-sitter parsing for TS, JS, Python, Go, Rust. Symbols, summaries, and 384-dim embeddings per file. Binary assets auto-excluded via configurable `excludePatterns`.
- **Hybrid search** &mdash; FTS5 full-text + semantic vector search merged with tuned alpha weights. AND semantics for precision, BM25 column weights (path 1.5×, summary 1×, symbols 2×), test/config-file penalties, and **scope filtering** to restrict results by path prefix.
- **Evidence Bundles** &mdash; Deterministic, reproducible context packages with code spans, related commits, and linked notes.
- **Multi-agent coordination** &mdash; Agent registry, session management, file claims, patch proposals with stale-rejection. Live presence tracking with online/idle/offline status.
- **Trust & security** &mdash; Two-tier access (A/B), four roles (developer, reviewer, observer, admin), secret scanning.
- **Knowledge Store** &mdash; Two-scope architecture (repo-local + global cross-project). Seven types: decision, gotcha, pattern, context, plan, solution, preference. Dedicated `knowledge_fts` FTS5 table for fast search without requiring the semantic model.
- **Real-time dashboard** &mdash; Command center with live agents panel, SVG charts, SSE updates, tabbed data views. Configurable port via `--dashboard-port`.
- **Obsidian export** &mdash; One-click button in dashboard or CLI command to export all knowledge as Markdown with YAML frontmatter.

## Install

```bash
git clone https://github.com/xpm-cmd/Agora.git
cd Agora
pnpm install
pnpm build
```

**Requirements:** Node.js >= 22, pnpm

## Quick Start

```bash
cd your-project
agora init                    # Create .agora/ with config
agora index                   # Parse all tracked files
agora serve                   # Start MCP server (stdio)
agora serve --transport http  # Or HTTP mode + dashboard
```

Add to Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "agora": {
      "command": "agora",
      "args": ["serve"]
    }
  }
}
```

## Tools

22 MCP tools organized by domain:

| Domain | Tools |
|--------|-------|
| **Search** | `status`, `capabilities`, `schema`, `get_code_pack`, `get_change_pack`, `get_issue_pack` |
| **Agents** | `register_agent`, `agent_status`, `broadcast`, `claim_files` |
| **Coordination** | `send_coordination`, `poll_coordination` |
| **Patches** | `propose_patch`, `list_patches` |
| **Notes** | `propose_note`, `list_notes` |
| **Knowledge** | `store_knowledge`, `search_knowledge`, `query_knowledge`, `archive_knowledge`, `delete_knowledge` |
| **Index** | `request_reindex` |

## Architecture

```
agora serve
    |
    +---> MCP Server (stdio | HTTP)
    |        |
    |        +---> 22 Tools ---> Trust Layer (Tier A/B + Roles)
    |        |                      |
    |        |       Search --------+---> FTS5 + Semantic Hybrid + Scope Filter
    |        |       Evidence Bundles ---> Stage A (top 5) + Stage B (expand 3)
    |        |       Coordination Bus --> hub-spoke | hybrid | mesh
    |        |       Knowledge Store --> repo (.agora/) + global (~/.agora/)
    |        |
    |        +---> Repo DB (.agora/agora.db)
    |        +---> Global DB (~/.agora/knowledge.db)
    |
    +---> Dashboard (http://localhost:3141)
             +---> Live Agents + REST API + SSE + SVG Charts
```

### Search Pipeline

```
Code Search (get_code_pack):
  Query + scope? ──► FTS5 (AND semantics, BM25 path=1.5× summary=1× symbols=2×)
                         │ scope → WHERE path LIKE 'prefix%'
                         │ test penalty → ×0.7 when query ≠ test
                         │ config penalty → ×0.5 for tsconfig, eslintrc, etc.
                         ▼
                     Semantic embedding (MiniLM-L6-v2, 384d)
                         │ scope → post-filter vector results
                         ▼
                     Hybrid merge (alpha=0.5) ──► Evidence Bundle

Knowledge Search (search_knowledge):
  Query ──► FTS5 knowledge_fts (BM25 title=3× content=1× tags=2×)
                │ always available (no model dependency)
                ▼
            Semantic blend (if model loaded, alpha=0.5)
                ▼
            Ranked knowledge entries
```

### Trust Model

| Tier | Access | Roles |
|------|--------|-------|
| **A** | Full code + code spans + propose patches/notes | developer, reviewer, admin |
| **B** | Redacted, read-only | observer |

## Dashboard

Built-in command center (default port 3141, configurable via `--dashboard-port`) with:

- **Live Agents panel** &mdash; Online/idle/offline status dots, role badges, claimed files, 10s cross-process polling
- **SVG Charts** &mdash; Activity sparkline, tool usage donut, knowledge type bars, patch state ring
- **Tabbed data views** &mdash; Agents, Activity Log, Patches, Notes, Knowledge (with live counters)
- **SSE real-time updates** &mdash; 7 event types streamed to connected browsers
- **One-click Obsidian export** &mdash; Button in the dashboard UI

## Obsidian Export

```bash
agora export --obsidian                          # Export to repo root
agora export --obsidian --vault ~/MyVault        # Export to specific vault
```

## CLI Reference

```
agora v1.0.0

Commands:  serve | init | index | status | export

Options:
  --repo-path       Path to the git repository (default: cwd)
  --transport       stdio | http (default: stdio)
  --http-port       HTTP server port (default: 3141)
  --dashboard-port  Dashboard port when separate from HTTP (default: same as http-port)
  --verbosity       quiet | normal | verbose (default: normal)
  --semantic         Enable semantic search (overrides config)
  --no-dashboard    Disable dashboard UI
  --no-semantic     Disable semantic search
  --debug-logging   Store raw payloads in debug_payloads table (TTL 24h)
  --obsidian        Export knowledge to Obsidian vault
  --vault           Target vault path for export
  --version         Show version
  --help            Show help
```

## Development

```bash
pnpm build        # Build with tsup
pnpm typecheck    # TypeScript strict
pnpm test         # 222 tests (vitest)
pnpm dev          # Watch mode
```

## Tech Stack

TypeScript (strict) &middot; Node.js 22+ &middot; MCP SDK &middot; SQLite + Drizzle ORM &middot; FTS5 + ONNX MiniLM-L6-v2 &middot; Tree-sitter &middot; Zod v4 &middot; tsup &middot; Vitest

## License

[MIT](LICENSE)
