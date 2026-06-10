# Monsthera v3

Knowledge-native development platform for AI coding agents.

Monsthera gives AI agents a shared brain, a work model, and the ability to coordinate — built as an MCP server + CLI.

## Operating Model

Use Monsthera as an execution layer, not as passive storage:

- For code generation: build a context pack in Search, move the selected refs into a work article, then implement from that contract.
- For investigations: use Search in research mode, prefer fresh and source-linked items, and capture conclusions in Knowledge.
- For durable memory: store reusable guides, decisions, and imported context in Knowledge with code refs when possible.
- For multi-agent work: keep ownership, blockers, and review gates explicit in Work so automation stays safe and handoffs stay cheap.

Agents should prefer `build_context_pack` before deep work and should not call manual reindex tools after normal knowledge/work CRUD flows.

## Status

**v3.0.0** — Stable. The v3 clean rewrite has shipped (see [CHANGELOG](CHANGELOG.md)).

v2 was maintained on the `release/2.x` branch, which has since been retired.

## Architecture

Monsthera v3 is built around these core concepts:

- **Knowledge articles** — Markdown-native documents that form the shared knowledge base
- **Work articles** — The canonical work unit, replacing tickets with enriched documentation
- **Phase state machine** — 5-phase lifecycle (planning → enrichment → implementation → review → done)
- **Guard-driven orchestration** — Deterministic boolean guards enable automated phase transitions. Ships wave planning, autoadvance, agent dispatch (ADR-008), and convoy coordination — named groups where the lead's progress unblocks members (ADR-009, hardened in ADR-013, via `monsthera convoy create|list|get|complete|cancel`).
- **Dual storage** — Markdown files are the source of truth for knowledge and work articles. Dolt (optional) stores derived data: the search index and orchestration events.

See [Architecture Docs](MonstheraV3/monsthera-architecture-v6-final.md) for the full design vision. The ADR describes the target architecture; not all features are shipped yet.

## Development

```bash
pnpm install
pnpm dev          # Start in dev mode
pnpm build        # Build for production
pnpm test         # Run tests
pnpm typecheck    # Type check
pnpm lint         # Lint
pnpm exec tsx src/bin.ts ingest local --path docs/adrs --summary
```

## Local Dolt

Monsthera v3 already supports Dolt for structured storage in hybrid mode:

- Markdown remains the source of truth for knowledge/work articles
- Dolt stores the search index and orchestration events

Quick start without Docker:

```bash
pnpm dolt:install
pnpm dolt:start:daemon

MONSTHERA_DOLT_ENABLED=true \
MONSTHERA_DOLT_HOST=127.0.0.1 \
MONSTHERA_DOLT_PORT=3306 \
MONSTHERA_DOLT_DATABASE=monsthera \
pnpm exec tsx src/bin.ts status
```

See [Local Dolt Guide](docs/dolt-local.md) for the full setup and runtime commands.

## Portable Workspace Operations

The Monsthera executable can be updated independently from a repo's portable workspace. The workspace data is:

- `knowledge/` — Markdown source of truth
- `.monsthera/config.json` and `.monsthera/manifest.json` — local config and schema metadata
- `.monsthera/dolt/` — local Dolt data for search, events, and snapshots

Useful commands:

```bash
pnpm exec tsx src/bin.ts workspace status
pnpm exec tsx src/bin.ts workspace migrate
pnpm exec tsx src/bin.ts workspace backup
pnpm exec tsx src/bin.ts workspace restore .monsthera/backups/<backup-id> --force
pnpm exec tsx src/bin.ts self status
pnpm exec tsx src/bin.ts self update --dry-run
pnpm exec tsx src/bin.ts self update --prepare
pnpm exec tsx src/bin.ts self update --execute
pnpm exec tsx src/bin.ts self restart dolt
```

`workspace backup` is the safe first step before upgrades or schema migrations.
`self update --prepare` creates that backup and prints the remaining update steps.
`self update --execute` runs the guarded local update when there are no blockers.

## Local Demo

You can now run the V3 demo flow from this repository directly:

```bash
pnpm demo:local
pnpm demo:smoke
```

The script will:

- install/start local Dolt if needed
- start with an empty corpus (run `monsthera migrate` manually to import v2 data)
- reindex search against Dolt
- launch the dashboard on `http://localhost:4123`

Inside the dashboard you can now:

- open the new Guide screen for onboarding, section intent, agent orchestration, and supervised automation
- use Search to build context packs for code generation or investigation instead of reading the repo blindly
- create/edit/delete knowledge articles
- import local `.md` / `.txt` sources into knowledge from the Knowledge screen
- choose between raw import and summarized import for long source documents
- create/edit/delete work articles
- advance work through phases
- record enrichment contributions
- assign reviewers and submit reviews
- trigger reindex from `System -> Storage & Indexing`
- link and unlink work dependencies from the Work queue

`pnpm demo:smoke` runs an end-to-end validation on top of the same repo:

- starts Dolt locally if needed
- ensures the Markdown corpus exists
- reindexes search
- boots the dashboard on `http://localhost:4124`
- exercises knowledge CRUD, work CRUD, dependency linking, lifecycle advance, review approval, audit events, and cleanup

## CLI Highlights

```bash
pnpm exec tsx src/bin.ts knowledge create --title "API Design" --category architecture --content "REST vs GraphQL..."
pnpm exec tsx src/bin.ts knowledge create --title "Run 42" --category solution --field replicability_score=0.91   # custom frontmatter (ADR-020)
pnpm exec tsx src/bin.ts knowledge list --filter "custom.replicability_score<0.8"   # query by a custom field
pnpm exec tsx src/bin.ts work create --title "Add auth" --template feature --author agent-1 --priority high
pnpm exec tsx src/bin.ts ingest local --path docs/adrs --category docs --summary
pnpm exec tsx src/bin.ts ingest git --range HEAD~10..HEAD     # ingest commits as knowledge (origin: ingested)
pnpm exec tsx src/bin.ts lint --registry custom-frontmatter   # validate custom fields against a policy
pnpm exec tsx src/bin.ts doctor                               # health + provenance / staleness / contradiction report
pnpm exec tsx src/bin.ts reindex
```

### Custom frontmatter & provenance

Custom frontmatter (ADR-020) is first-class: **authorable** (`--field key=value`, or the MCP `extraFrontmatter` object on `create_article`/`update_article`), **queryable** (`knowledge list --filter "custom.<key><op><value>"` and the `list_articles` MCP tool — `=` is string equality, `<`/`<=`/`>`/`>=` are numeric, scalars only), and **validatable** (`lint --registry custom-frontmatter` against per-category rules declared in a `policy` article — see [`AGENTS.md`](AGENTS.md) for the recipe).

Every article carries provenance under `origin` (`agent` | `human` | `distilled` | `ingested`), resolved at read-time so the default (`agent`) is never written to disk. `monsthera doctor` reports the corpus provenance breakdown alongside staleness and cross-article contradictions.

## Semantic Search

Search runs **BM25-only by default** — no external services required. To add
hybrid semantic ranking (local embeddings via [Ollama](https://ollama.com)):

```bash
ollama pull nomic-embed-text                     # one-time: fetch the embedding model
pnpm exec tsx src/bin.ts self enable-semantic    # verify Ollama, persist the flag, reindex
```

`self enable-semantic` refuses to proceed if Ollama is unreachable or the model
is missing, printing the exact `ollama pull` command to run. `monsthera doctor`
reports embedding-provider readiness, and `monsthera self enable-semantic --json`
emits a machine-readable result.

Ranking is tunable without code changes via `MONSTHERA_SEARCH_*` env vars
(`BM25K1`, `TITLE_BOOST`, `FRESHNESS_FRESH_DAYS`, `FRESHNESS_STALE_DAYS`,
`RERANK_ENABLED`, `RANK_PROFILE`); measure changes with `monsthera eval`.

## Design Documents

- [Architecture v6](MonstheraV3/monsthera-architecture-v6-final.md) — Primary design source
- [Work Article Design](MonstheraV3/monsthera-ticket-as-article-design.md) — Domain model spec
- [Implementation Plan](MonstheraV3/monsthera-v3-implementation-plan-final.md) — Execution plan
- [Dashboard UX Plan](docs/dashboard-ux-plan.md) — Dashboard operating model and usability roadmap
- [ADRs](docs/adrs/) — Architecture Decision Records
- [Coding Standards](docs/CODING-STANDARDS.md) — Code conventions
- [Consumer Setup](docs/consumer-setup.md) — Wiring Monsthera into a downstream repo, including `self enable-semantic` for semantic search

## License

MIT
