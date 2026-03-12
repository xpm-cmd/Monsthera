<p align="center">
  <strong>&#9670; Agora</strong>
</p>

<p align="center">
  Local, commit-scoped shared context and multi-agent coordination for co-coding.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/agora-mcp"><img src="https://img.shields.io/npm/v/agora-mcp" alt="npm version"></a>
  <a href="https://github.com/xpm-cmd/Agora/actions"><img src="https://github.com/xpm-cmd/Agora/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js >= 22">
</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#tools">Tools</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#dashboard">Dashboard</a> &middot;
  <a href="#contributing">Contributing</a> &middot;
  <a href="LICENSE">MIT License</a>
</p>

---

Agora is an [MCP server](https://modelcontextprotocol.io/) for local-first shared context, ticketing,
and multi-agent coordination during software work.
It indexes your repository with Git-aware parsing, provides hybrid semantic search,
coordinates multiple agents through trust-enforced tools, persists knowledge across sessions,
and ships with a dashboard for presence, tickets, patches, notes, and search debugging.

Everything runs locally. No cloud. No API keys. Configuration lives in `.agora/config.json`.

## Features

- **Git-aware indexing** &mdash; Tree-sitter parsing for TS, JS, Python, Go, Rust. Symbols, summaries, secret detection, and 384-dim embeddings per file. Binary assets auto-excluded via configurable `excludePatterns`.
- **Hybrid search** &mdash; FTS5 full-text + semantic vector search merged with tuned alpha weights. Scope filtering, test/config-file penalties, evidence bundles, and a search debugger UI for ranking internals.
- **Ticketing and backlog** &mdash; Structured tickets with workflow states, comments, linked patches, dependency links, search, and dashboard actions for create, assign, and transition.
- **Multi-agent coordination** &mdash; Agent registry, session management, file claims, coordination messages, patch proposals with stale-rejection, and shared presence tracking.
- **Trust & security** &mdash; Two-tier access (A/B), four roles (developer, reviewer, observer, admin), optional registration auth, and configurable secret scanning rules.
- **Knowledge Store** &mdash; Two-scope architecture (repo-local + global cross-project). Seven knowledge types with FTS5-backed search and semantic reranking when available.
- **Dashboard** &mdash; Command center with live agents, activity charts, agent timeline, search debugger, tickets board/table, knowledge views, and read/write ticket actions on the local server.
- **Obsidian export** &mdash; One-click button in dashboard or CLI command to export all knowledge as Markdown with YAML frontmatter.

## Install

```bash
npm install -g agora-mcp
```

Or use directly with `npx`:

```bash
npx agora-mcp serve
```

<details>
<summary><strong>Build from source</strong></summary>

```bash
git clone https://github.com/xpm-cmd/Agora.git
cd Agora
pnpm install
pnpm build
```
</details>

**Requirements:** Node.js >= 22. Native build tools (Python 3, make, gcc/clang) needed for `better-sqlite3`.

## Quick Start

```bash
cd your-project
agora init                    # Create .agora/config.json and local DB
agora index                   # Full index of tracked files
agora index --incremental     # Fast refresh from the last indexed commit
agora serve                   # Start MCP server over stdio
agora serve --transport http  # Start HTTP MCP + dashboard
agora status                  # Check index status, backend, and live sessions
```

Agora also runs `agora index --incremental` automatically in a local git `post-commit` hook so
committed code is reindexed before reviewers or subsequent agents query fresh context.

In HTTP mode, MCP is exposed at `http://localhost:3000/mcp` and the dashboard runs at
`http://localhost:3141` by default.

Add to your MCP client config (e.g., Claude Code `.claude/settings.json`):

```json
{
  "mcpServers": {
    "agora": {
      "command": "npx",
      "args": ["-y", "agora-mcp", "serve"]
    }
  }
}
```

## Tools

42 MCP tools organized by domain:

| Domain | Tools |
|--------|-------|
| **Search** | `status`, `capabilities`, `schema`, `get_code_pack`, `get_change_pack`, `get_issue_pack`, `search_remote_instances` |
| **Agents** | `register_agent`, `agent_status`, `broadcast`, `claim_files`, `end_session` |
| **Coordination** | `send_coordination`, `poll_coordination` |
| **Patches** | `propose_patch`, `list_patches` |
| **Notes** | `propose_note`, `list_notes` |
| **Knowledge** | `store_knowledge`, `search_knowledge`, `query_knowledge`, `archive_knowledge`, `delete_knowledge` |
| **Tickets** | `create_ticket`, `assign_ticket`, `update_ticket_status`, `update_ticket`, `list_tickets`, `search_tickets`, `get_ticket`, `comment_ticket`, `link_tickets`, `unlink_tickets` |
| **Protection** | `add_protected_artifact`, `remove_protected_artifact`, `list_protected_artifacts` |
| **Analysis** | `analyze_complexity`, `analyze_test_coverage`, `suggest_actions`, `lookup_dependencies` |
| **Index** | `request_reindex` |
| **Export** | `export_audit` |

## Agent-First Operational Access

When an agent or script needs repository state, prefer Agora-native access in this order:

1. Specialized CLI commands for common workflows
2. `agora tool inspect <tool> --json` to discover tool inputs
3. `agora tool <tool> --input '{...}' --json` for direct local MCP tool invocation
4. Direct reads from `.agora/agora.db` only as a last resort

Why this order:

- specialized commands and `agora tool` keep repo scoping, validation, auth checks, telemetry, and workflow invariants
- direct SQLite access bypasses those guards and should not be the default path for agents

Operational examples:

```bash
agora ticket summary --json
agora patch list --json
agora patch show patch-123 --json
agora knowledge search "ticket workflow" --scope all --json
agora tool list
agora tool inspect propose_patch --json
agora tool status --json
agora tool claim_files --input '{"agentId":"agent-dev","sessionId":"session-dev","paths":["src/index.ts"]}' --json
```

Patch review guidance:

- use `agora patch list --json` to review current patch states plus live staleness against current `HEAD`
- use `agora patch show <proposal-id> --json` to inspect feasibility, policy violations, secret warnings, touched path counts, and linked ticket metadata before opening raw diffs

## Architecture

```
agora serve
    |
    +---> MCP Server (stdio | HTTP)
    |        |
    |        +---> 42 Tools ---> Trust Layer (Tier A/B + Roles)
    |        |                      |
    |        |       Search --------+---> FTS5 + Semantic Hybrid + Scope Filter
    |        |       Evidence Bundles ---> Stage A (top 10) + Stage B (expand 5)
    |        |       Coordination Bus --> shared DB-backed coordination
    |        |       Knowledge Store --> repo (.agora/) + global (~/.agora/)
    |        |       Ticketing -------> lifecycle + comments + patch linkage + dependencies
    |        |
    |        +---> Repo DB (.agora/agora.db)
    |        +---> Global DB (~/.agora/knowledge.db)
    |
    +---> Dashboard (http://localhost:3141)
             +---> Live Agents + Timeline + Search Debug + Tickets + Charts
```

### Search Pipeline

```
Code Search (get_code_pack):
  Query + scope? ──► FTS5 (≤3 terms: AND, 4+ terms: OR; BM25 path=1.5× summary=1× symbols=2×)
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
                │
                ├── if semantic model loaded:
                │       Independent vector scan (all embeddings, cosine ≥ 0.6)
                │       ──► discovers entries with zero keyword overlap
                │       ──► merge: FTS5 ∪ vector results (alpha=0.5)
                │
                └── else: return FTS5 results ranked by BM25
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

- **Live Agents** &mdash; Presence cards, roles, claimed files, stale-agent hiding, and repo name in the header
- **Activity and operations charts** &mdash; Activity, tool usage, indexed files, knowledge types, and patch states
- **Agent Timeline** &mdash; Per-agent recent activity from runtime event logs
- **Search Debugger** &mdash; Inspect runtime backend, lexical backend, and result buckets for code search
- **Tickets** &mdash; Table and kanban views, filters, comments, history, linked patches, dependencies, templates, and local actions
- **Knowledge, patches, notes, and agents** &mdash; Tabbed operational views with live counts
- **Obsidian export** &mdash; Button in the dashboard UI

## Obsidian Export

```bash
agora export --obsidian                          # Export to repo root
agora export --obsidian --vault ~/MyVault        # Export to specific vault
```

## CLI Reference

```
agora v1.0.0

Commands:  serve | init | index | status | export | ticket | patch | knowledge | tool

Options:
  --repo-path       Path to the git repository (default: cwd)
  --transport       stdio | http (default: stdio)
  --http-port       HTTP server port (default: 3000)
  --dashboard-port  Dashboard UI port (default: 3141)
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
pnpm test         # Run the Vitest suite
pnpm dev          # Watch mode
```

## Tech Stack

TypeScript (strict) &middot; Node.js 22+ &middot; MCP SDK &middot; SQLite + Drizzle ORM &middot; FTS5 + ONNX MiniLM-L6-v2 &middot; Tree-sitter &middot; Zod v4 &middot; tsup &middot; Vitest

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style guidelines, and PR process.

For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## Getting Help

- [GitHub Issues](https://github.com/xpm-cmd/Agora/issues) &mdash; bug reports, feature requests
- [docs/architecture.md](docs/architecture.md) &mdash; runtime and storage architecture
- [docs/search-pipeline.md](docs/search-pipeline.md) &mdash; indexing and retrieval details
- [docs/agent-roles.md](docs/agent-roles.md) &mdash; roles, registration auth, and sessions
- [docs/patch-lifecycle.md](docs/patch-lifecycle.md) &mdash; patch validation and lifecycle
- [docs/ticket-workflow.md](docs/ticket-workflow.md) &mdash; ticket states, QA conventions, and dependencies

## License

[MIT](LICENSE)
