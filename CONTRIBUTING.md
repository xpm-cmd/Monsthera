# Contributing to Agora

Thank you for your interest in contributing to Agora! This document provides guidelines and instructions for contributing.

## Development Setup

### Prerequisites

- **Node.js 22+** (required)
- **pnpm** (package manager, installed via `corepack enable`)
- **Python 3** + build tools (`make`, `gcc`/`clang`) — needed for `better-sqlite3` native module
- **Git** (for repository operations)

### Getting Started

```bash
git clone https://github.com/xpm-cmd/Agora.git
cd Agora
pnpm install
pnpm build
pnpm test
```

### Development Commands

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start dev server with hot reload (stdio) |
| `pnpm dev:http` | Start dev server with HTTP transport |
| `pnpm build` | Build with tsup |
| `pnpm test` | Run all unit tests |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm lint` | Lint source and test files |
| `pnpm typecheck` | TypeScript type checking |
| `pnpm format` | Format code with Prettier |

## Making Changes

### Branch Workflow

1. Fork the repository
2. Create a feature branch from `main`: `git checkout -b feat/my-feature`
3. Make your changes
4. Run `pnpm typecheck && pnpm lint && pnpm test` to verify
5. Commit with a descriptive message (see below)
6. Push and open a Pull Request

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(search): add fuzzy matching to FTS5 queries
fix(agents): prevent stale session accumulation
docs: update search pipeline documentation
test(knowledge): add hybrid search edge cases
refactor(trust): simplify role permission matrix
```

### Code Style

- TypeScript strict mode is enforced (`strict: true`, `noUncheckedIndexedAccess: true`)
- ESLint + Prettier handle formatting — run `pnpm format` before committing
- Use descriptive variable names; avoid abbreviations
- All public functions should have JSDoc comments
- Error handling: use custom error classes from `src/core/errors.ts`
- Logging: use `InsightStream` methods (`info`, `detail`, `debug`, `warn`, `error`)

### Testing

- Unit tests go in `tests/unit/` mirroring the `src/` directory structure
- Use Vitest (`describe`, `it`, `expect`)
- Test files must be named `*.test.ts`
- All new features require tests; bug fixes should include a regression test

## Architecture Overview

```
src/
├── core/          # Config, constants, error types, logging
├── db/            # SQLite schema, queries, migrations
├── git/           # Git operations, language detection
├── indexing/      # Code parser, file indexer, summaries
├── search/        # FTS5 backend, semantic reranker
├── retrieval/     # Evidence bundle pipeline
├── trust/         # Trust tiers, roles, secret scanning
├── tools/         # MCP tool handlers (23 tools)
├── agents/        # Agent registry, session management
├── coordination/  # Inter-agent messaging bus
├── patches/       # Patch proposal and validation
├── logging/       # Event logger with audit trail
├── dashboard/     # Admin web UI (HTML + API)
├── export/        # Obsidian markdown export
└── server.ts      # MCP server factory
```

## Reporting Issues

- Use [GitHub Issues](https://github.com/xpm-cmd/Agora/issues)
- Include: Agora version, Node.js version, OS, and steps to reproduce
- For security vulnerabilities, see [SECURITY.md](SECURITY.md)

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
