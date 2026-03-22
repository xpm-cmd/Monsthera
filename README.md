<p align="center">
  <strong>&#9670; Monsthera</strong>
</p>

<p align="center">
  Give your AI coding agents a shared brain, a backlog, and the ability to work together.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/monsthera-mcp"><img src="https://img.shields.io/npm/v/monsthera-mcp" alt="npm version"></a>
  <a href="https://github.com/xpm-cmd/Monsthera/actions"><img src="https://github.com/xpm-cmd/Monsthera/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-BUSL--1.1-blue.svg" alt="BUSL-1.1 License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen" alt="Node.js >= 22">
</p>

<p align="center">
  <a href="#install">Install</a> &middot;
  <a href="#quick-start">Quick Start</a> &middot;
  <a href="#tools">Tools</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#dashboard">Dashboard</a> &middot;
  <a href="#contributing">Contributing</a> &middot;
  <a href="LICENSE">License</a>
</p>

---

AI agents are powerful alone but blind to each other. Each one starts from scratch, re-reads the same files, and has no way to share what it learned. Monsthera fixes that.

Monsthera turns your repository into a workspace where multiple agents can search code semantically, coordinate through tickets, propose patches, and build on each other's knowledge. It connects to your tools via [MCP](https://modelcontextprotocol.io/) and CLI.

One `npx monsthera-mcp serve` and your agents get hybrid search (keyword + semantic), a full ticketing system with governance, persistent cross-session knowledge, file-level coordination, and a dashboard to see it all happening.

## Features

- **Git-aware indexing** &mdash; Tree-sitter parsing for TS, JS, Python, Go, Rust. Symbols, summaries, imports, symbol references, code chunks, secret detection, and 384-dim embeddings per file and chunk. Binary assets auto-excluded via configurable `excludePatterns`.
- **Hybrid search** &mdash; FTS5 full-text + semantic vector search merged with tuned alpha weights. Scope filtering, test/config-file penalties, evidence bundles, chunk-level embeddings, and a search debugger UI for ranking internals.
- **Ticketing and backlog** &mdash; Structured tickets with 10 workflow states, comments, linked patches, dependency links (`blocks`/`relates_to`), council review with quorum-based governance, and dashboard actions for create, assign, and transition.
- **Multi-agent coordination** &mdash; Agent registry, session management, file claims, coordination messages with lane-aware bus, patch proposals with stale-rejection, shared presence tracking, and agent spawning.
- **Governance & council review** &mdash; Quorum-based ticket advancement with specialized council roles (security, architecture, testing, performance, documentation). Verdicts are append-only with supersession tracking.
- **Wave orchestration & convoys** &mdash; Parallel ticket execution through wave scheduling. Convoys group independent tickets into waves, spawn agents per ticket, and manage integration branches for coordinated merges.
- **Job board** &mdash; Loop-based workforce management with job slots, claim/release lifecycle, heartbeat monitoring, and progress tracking for developer, reviewer, and planner loops.
- **Goal decomposition** &mdash; Structured goal breakdown into tasks with DAG-validated dependency graphs. Dry-run validation before ticket creation.
- **Simulation framework** &mdash; Multi-phase simulation runs (A→E) for testing ticket workflows, council review, and wave orchestration without side effects.
- **Trust & security** &mdash; Two-tier access (A/B), four roles (developer, reviewer, observer, admin), optional registration auth, configurable secret scanning rules, and tool-level rate limiting.
- **Knowledge Store** &mdash; Two-scope architecture (repo-local + global cross-project). Seven knowledge types with FTS5-backed search and semantic reranking when available.
- **Work groups** &mdash; Aggregate tracking for multi-ticket features with auto-completion when all tickets resolve.
- **Dashboard** &mdash; Command center with live agents, activity charts, agent timeline, search debugger, tickets board/table, knowledge views, convoy status, and read/write ticket actions on the local server.
- **Obsidian export** &mdash; One-click button in dashboard or CLI command to export all knowledge as Markdown with YAML frontmatter.

## Install

```bash
npm install -g monsthera-mcp
```

Or use directly with `npx`:

```bash
npx monsthera-mcp serve
```

<details>
<summary><strong>Build from source</strong></summary>

```bash
git clone https://github.com/xpm-cmd/Monsthera.git
cd Monsthera
pnpm install
pnpm build
```
</details>

**Requirements:** Node.js >= 22. Native build tools (Python 3, make, gcc/clang) needed for `better-sqlite3`.

## Quick Start

```bash
cd your-project
monsthera init                    # Create .monsthera/config.json and local DB
monsthera index                   # Full index of tracked files
monsthera index --incremental     # Fast refresh from the last indexed commit
monsthera serve                   # Start MCP server over stdio
monsthera serve --transport http  # Start HTTP MCP + dashboard
monsthera status                  # Check index status, backend, and live sessions
```

Monsthera also runs `monsthera index --incremental` automatically in a local git `post-commit` hook so
committed code is reindexed before reviewers or subsequent agents query fresh context.

In HTTP mode, MCP is exposed at `http://localhost:3000/mcp` and the dashboard runs at
`http://localhost:3141` by default.

Add to your MCP client config (e.g., Claude Code `.claude/settings.json`):

```json
{
  "mcpServers": {
    "monsthera": {
      "command": "npx",
      "args": ["-y", "monsthera-mcp", "serve"]
    }
  }
}
```

## Tools

72 MCP tools organized by domain:

| Domain | Tools |
|--------|-------|
| **Search** | `status`, `capabilities`, `schema`, `get_code_pack`, `get_change_pack`, `get_issue_pack`, `search_remote_instances` |
| **Agents** | `register_agent`, `agent_status`, `broadcast`, `claim_files`, `end_session`, `spawn_agent` |
| **Coordination** | `send_coordination`, `poll_coordination` |
| **Patches** | `propose_patch`, `list_patches` |
| **Notes** | `propose_note`, `list_notes` |
| **Knowledge** | `store_knowledge`, `search_knowledge`, `query_knowledge`, `archive_knowledge`, `delete_knowledge` |
| **Tickets** | `create_ticket`, `assign_ticket`, `update_ticket_status`, `update_ticket`, `list_tickets`, `search_tickets`, `get_ticket`, `comment_ticket`, `link_tickets`, `unlink_tickets`, `prune_stale_relations` |
| **Council** | `assign_council`, `submit_verdict`, `check_consensus`, `list_verdicts` |
| **Protection** | `add_protected_artifact`, `remove_protected_artifact`, `list_protected_artifacts` |
| **Analysis** | `analyze_complexity`, `analyze_test_coverage`, `analyze_coupling`, `find_dependency_cycles`, `suggest_actions`, `suggest_next_work`, `lookup_dependencies`, `find_references`, `trace_dependencies` |
| **Workflows** | `run_workflow`, `decompose_goal` |
| **Jobs** | `create_loop`, `list_jobs`, `claim_job`, `update_job_progress`, `complete_job`, `release_job` |
| **Work Groups** | `create_work_group`, `update_work_group`, `add_tickets_to_group`, `remove_tickets_from_group`, `list_work_groups` |
| **Waves** | `compute_waves`, `launch_convoy`, `advance_wave`, `get_wave_status` |
| **Simulation** | `run_simulation`, `run_optimization` |
| **Index** | `request_reindex` |
| **Export** | `export_audit` |

## Agent-First Operational Access

When an agent or script needs repository state, prefer Monsthera-native access in this order:

1. Specialized CLI commands for common workflows
2. `monsthera tool inspect <tool> --json` to discover tool inputs
3. `monsthera tool <tool> --input '{...}' --json` for direct local MCP tool invocation
4. Direct reads from `.monsthera/monsthera.db` only as a last resort

Why this order:

- specialized commands and `monsthera tool` keep repo scoping, validation, auth checks, telemetry, and workflow invariants
- direct SQLite access bypasses those guards and should not be the default path for agents

Operational examples:

```bash
monsthera ticket summary --json
monsthera patch list --json
monsthera patch show patch-123 --json
monsthera knowledge search "ticket workflow" --scope all --json
monsthera loop plan --json
monsthera loop plan --watch
monsthera facilitator --watch
monsthera loop dev --limit 3 --json
monsthera loop dev --watch
monsthera loop council TKT-1234abcd --transition in_review->ready_for_commit --json
monsthera loop council --watch
monsthera tool list
monsthera tool inspect propose_patch --json
monsthera tool status --json
monsthera tool claim_files --input '{"agentId":"agent-dev","sessionId":"session-dev","paths":["src/index.ts"]}' --json
```

Loop command guide: [docs/agent-loops.md](docs/agent-loops.md)
Operational playbooks: [docs/playbooks.md](docs/playbooks.md)

Patch review guidance:

- use `monsthera patch list --json` to review current patch states plus live staleness against current `HEAD`
- use `monsthera patch show <proposal-id> --json` to inspect feasibility, policy violations, secret warnings, touched path counts, and linked ticket metadata before opening raw diffs

## Architecture

```
monsthera serve / monsthera orchestrate / monsthera loop
    |
    +---> MCP Server (stdio | HTTP)
    |        |
    |        +---> 72 Tools ---> Trust Layer (Tier A/B + Roles + Rate Limits)
    |        |                      |
    |        |       Search --------+---> FTS5 + Semantic Hybrid + Chunk Embeddings
    |        |       Evidence Bundles ---> Stage A (top 10) + Stage B (expand 5)
    |        |       Coordination Bus --> lane-aware DB-backed messaging
    |        |       Knowledge Store --> repo (.monsthera/) + global (~/.monsthera/)
    |        |       Ticketing -------> lifecycle + council review + governance
    |        |       Waves -----------> convoy scheduling + integration branches
    |        |       Jobs ------------> loop workforce + slot management
    |        |
    |        +---> Repo DB (.monsthera/monsthera.db)
    |        +---> Global DB (~/.monsthera/knowledge.db)
    |
    +---> Orchestrator (multi-agent loop coordination)
    |        +---> Agent Spawning + Failover + Problem Handling
    |
    +---> Dashboard (http://localhost:3141)
             +---> Agents + Timeline + Tickets + Knowledge + Convoys + Charts
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
monsthera export --obsidian                          # Export to repo root
monsthera export --obsidian --vault ~/MyVault        # Export to specific vault
```

## CLI Reference

```
monsthera v1.0.0

Commands:
  serve              Start MCP server (stdio or HTTP) + dashboard
  init               Create .monsthera/config.json and local DB
  index              Full or incremental index of tracked files
  status             Check index status, backend, and live sessions
  export             Export knowledge to Obsidian vault
  ticket             Ticket management (summary, create, show)
  patch              Patch management (list, show)
  knowledge          Knowledge store operations (search, list)
  tool               Direct MCP tool invocation (list, inspect, call)
  loop               Run agent loops (plan, dev, council) with --watch mode
  facilitator        Run the facilitator loop (planner + dispatcher)
  orchestrate        Multi-agent orchestrator with spawn, failover, and convoy

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

- [GitHub Issues](https://github.com/xpm-cmd/Monsthera/issues) &mdash; bug reports, feature requests
- [docs/architecture.md](docs/architecture.md) &mdash; runtime and storage architecture
- [docs/search-pipeline.md](docs/search-pipeline.md) &mdash; indexing and retrieval details
- [docs/agent-roles.md](docs/agent-roles.md) &mdash; roles, registration auth, and sessions
- [docs/patch-lifecycle.md](docs/patch-lifecycle.md) &mdash; patch validation and lifecycle
- [docs/ticket-workflow.md](docs/ticket-workflow.md) &mdash; ticket states, QA conventions, and dependencies

## License

[BUSL-1.1](LICENSE) — Converts to Apache 2.0 on 2030-03-12.
