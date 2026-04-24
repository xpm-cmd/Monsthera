# AGENTS.md — working on Monsthera

This file is the portable agent briefing for every assistant (Claude Code, Codex, Cursor, Aider, Gemini, etc.) that modifies Monsthera's source code. Read it before your first tool call. Everything here is non-obvious from reading the tree cold.

For consumer/runtime usage (how *downstream repos* wire Monsthera as an MCP server), see [`docs/consumer-setup.md`](docs/consumer-setup.md). For overall product context, see [`README.md`](README.md).

## Tech stack

- **Node 22+**, **pnpm 10.x**, **TypeScript 5.9**, **Vitest 4**, **tsup** for builds.
- Runtime deps are intentionally minimal: `@modelcontextprotocol/sdk`, `mysql2`, `zod`. No React, no Next, no ORM. If you reach for a new dep, check it's genuinely needed.
- Target output: a single `dist/bin.js` that runs both the MCP server (`serve`) and the CLI.

## Commands you will actually need

| Task | Command | Notes |
|------|---------|-------|
| Install | `pnpm install` | Required in fresh worktrees — `node_modules` is not checked in. |
| Run tests | `pnpm test` | Unit tests are fast (<10s). Integration tests in `tests/integration/` may require `pnpm build` first. |
| Typecheck | `pnpm typecheck` | `tsc --noEmit`. Pre-existing errors in `tests/unit/persistence/dolt-search-repository.test.ts` are tracked separately — ignore them unless you're touching that file. |
| Lint | `pnpm lint` | ESLint on `src/` and `tests/`. |
| Build | `pnpm build` | Produces `dist/`. Needed before `tests/integration/cli-stream-separation.test.ts`. |
| Dev server | `pnpm dev` | `tsx watch src/bin.ts serve`. |

## Invariants — things you must not silently break

### 1. Stream separation (stdout vs stderr)

- **stdout** carries data only: JSON blobs, MCP protocol frames, command output the user will pipe to `jq`.
- **stderr** carries logs: structured JSON log entries (`level`, `message`, `timestamp`, `domain`). See [`src/core/logger.ts`](src/core/logger.ts).
- The test [`tests/integration/cli-stream-separation.test.ts`](tests/integration/cli-stream-separation.test.ts) pins this contract. If you add a `console.log` or `process.stdout.write` outside a command's data path, that test will fail.

### 2. `.monsthera/cache/` is ephemeral; nothing else under `.monsthera/` is

- Runtime state lives at `.monsthera/cache/runtime-state.json` (see [`src/core/runtime-state.ts`](src/core/runtime-state.ts)). Anything you write that is derivable / re-computable on next boot belongs in `.monsthera/cache/`.
- Persistent artefacts (workflows, configs) stay at the top of `.monsthera/` and are expected to be committable by downstream repos if they choose.
- Legacy path `.monsthera/runtime-state.json` is still *read* for back-compat and deleted on the next write — do not reintroduce writes to the legacy location.

### 3. `lastReindexAt` means "last user-initiated reindex"

- `searchService.fullReindex({ persistState })` takes an explicit flag. User-initiated paths (CLI `monsthera reindex`, MCP `reindex` tool, dashboard reindex button, doctor remediation) pass `persistState: true` (the default).
- The container's internal bootstrap reindex ([`src/core/container.ts`](src/core/container.ts) — the `shouldBootstrapSearchIndex` branch) passes `persistState: false`. Read-only operations like `monsthera status` must not mutate `runtime-state.json`.
- If you add a new caller of `fullReindex`, decide deliberately: is this the user asking, or is it internal cache rehydration? Default to `persistState: true` only when the user is actively asking for a reindex.

### 4. Markdown is the source of truth for knowledge/work articles

- `FileSystemKnowledgeArticleRepository` and `FileSystemWorkArticleRepository` write Markdown files under `knowledge/` with YAML frontmatter. Dolt (when enabled) indexes derived data only — search index, orchestration events, snapshots.
- Never rewrite an article by mutating both stores independently. The service layer orchestrates this.
- When authoring a knowledge file by hand: either place the full-frontmatter Markdown directly under `knowledge/notes/` (Monsthera will pick it up on next status/boot) **or** call `knowledge create --content <plain-body>` and let Monsthera generate the frontmatter. Never mix the two — `knowledge create` prepends a *second* frontmatter block on top of an existing one.

### 5. `Result<T, E>` over throwing

- Domain code returns `Result<T, StorageError>` ([`src/core/result.ts`](src/core/result.ts)). Services propagate errors explicitly; the CLI/server/MCP layer is where unwrapping happens.
- Throw only for programmer errors (contract violations, misuse). Never throw from a repo or service's happy path.

## Test layout

- `tests/unit/**` — fast, no I/O beyond `/tmp`. `createTestContainer()` gives you a wired container against a throwaway repo path.
- `tests/integration/**` — spawn processes, read/write disk, may depend on `dist/bin.js`. Don't add unit-style tests here.
- `tests/snapshots/**` — output-shape snapshots (CLI, MCP). Regenerate intentionally only, not to silence diffs.
- When adding a test for a bug fix: write the failing assertion first, confirm it fails against `main`, then implement the fix. `pnpm vitest run <file>` is much faster than `pnpm test`.

## If Monsthera itself is registered as an MCP server for this session

Check with `ToolSearch query="monsthera" max_results=15` at the start. If tools load, you can (and should) use them on the repo's own corpus:

- `build_context_pack(query, mode="code")` before large refactors.
- `search(query)` before writing new abstractions (see if a similar one exists).
- `create_article` to capture non-obvious decisions, gotchas, and patterns as you discover them.

If the search doesn't return Monsthera tools, proceed with Grep/Glob/Read — you are likely working on the Monsthera source *without* a running Monsthera instance, which is normal during development.

## How to author a policy (knowledge-driven orchestration rules)

A *policy article* is a knowledge article with `category: policy` whose frontmatter tells the orchestrator what must be true before a work article is allowed to advance. No TypeScript edit or redeploy is needed — drop a Markdown file into `knowledge/notes/` and it applies on the next readiness check.

Minimum shape:

```markdown
---
id: k-policy-your-slug
category: policy
slug: policy-your-slug
title: "Policy: <what it enforces>"
tags: [policy]
policy_applies_templates: [feature]
policy_phase_transition: enrichment->implementation
policy_content_matches: ["(?i)auth|oauth|session|token"]
policy_requires_roles: [security]
policy_requires_articles: []
policy_rationale: "One-line summary of why this exists."
createdAt: 2026-04-24T00:00:00Z
updatedAt: 2026-04-24T00:00:00Z
---
(Prose expanding on the rationale — audit trail for future readers.)
```

Rules:

- Every `policy_*` field is optional. Omitting `policy_applies_templates` means "applies to every template"; omitting `policy_content_matches` means "content is not inspected"; and so on.
- `policy_phase_transition` is `"<from>-><to>"`. `planning->enrichment` is never gated by a policy — there is not enough content yet to match.
- `policy_content_matches` uses JavaScript regex. The POSIX `(?i)` prefix is accepted and translated to the `i` flag for convenience.
- A malformed policy logs a warning and loads as vacuous (never applies). Don't rely on this — check `knowledge/index.md` after authoring to confirm your policy appears in the table.

See [`docs/adrs/007-policy-articles.md`](docs/adrs/007-policy-articles.md) for the full rationale and enforcement boundary. A working example lives at [`knowledge/notes/policy-example-security-enrichment.md`](knowledge/notes/policy-example-security-enrichment.md).

## Where to look next

- [`docs/CODING-STANDARDS.md`](docs/CODING-STANDARDS.md) — style, naming, formatting conventions.
- [`docs/adrs/`](docs/adrs/) — architectural decisions, start here for "why is it shaped this way?".
- [`docs/concurrency-model.md`](docs/concurrency-model.md) — single-writer-per-article contract.
- [`CHANGELOG.md`](CHANGELOG.md) — recent behavioural changes, in reverse-chronological order.
