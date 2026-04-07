# Monsthera v3

Knowledge-native development platform for AI coding agents.

Monsthera gives AI agents a shared brain, a work model, and the ability to coordinate — built as an MCP server + CLI.

## Status

**v3.0.0-alpha** — Clean rewrite in progress.

v2 is maintained on the `release/2.x` branch.

## Architecture

Monsthera v3 is built around these core concepts:

- **Knowledge articles** — Markdown-native documents that form the shared knowledge base
- **Work articles** — The canonical work unit, replacing tickets with enriched documentation
- **Phase state machine** — 5-phase lifecycle (planning → enrichment → implementation → review → done)
- **Guard-driven orchestration** — Deterministic boolean guards enable automated phase transitions
- **Dual storage** — Markdown files for humans, Dolt database for structured queries

See [Architecture Docs](MonstheraV3/monsthera-architecture-v6-final.md) for the full design.

## Development

```bash
pnpm install
pnpm dev          # Start in dev mode
pnpm build        # Build for production
pnpm test         # Run tests
pnpm typecheck    # Type check
pnpm lint         # Lint
```

## Design Documents

- [Architecture v6](MonstheraV3/monsthera-architecture-v6-final.md) — Primary design source
- [Work Article Design](MonstheraV3/monsthera-ticket-as-article-design.md) — Domain model spec
- [Implementation Plan](MonstheraV3/monsthera-v3-implementation-plan-final.md) — Execution plan
- [ADRs](docs/adrs/) — Architecture Decision Records
- [Coding Standards](docs/CODING-STANDARDS.md) — Code conventions

## License

MIT
