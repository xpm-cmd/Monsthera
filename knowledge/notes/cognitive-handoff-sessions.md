---
id: k-vo0fhcxl
title: Cognitive handoff sessions — system design and state
slug: cognitive-handoff-sessions
category: context
tags: [sessions, handoff, ollama, agent-bootstrap, design, phase-1, phase-3, phase-4]
codeRefs: [src/sessions/schemas.ts, src/sessions/repository.ts, src/sessions/in-memory-repository.ts, src/sessions/file-repository.ts, src/sessions/facts-extractor.ts, src/sessions/facts-extractor-git.ts, src/sessions/facts-extractor-joins.ts, src/sessions/llm-summarizer.ts, src/sessions/citation-validator.ts, src/sessions/handoff-renderer.ts, src/sessions/service.ts, src/cli/session-commands.ts, src/core/types.ts:50, src/core/container.ts, src/core/config.ts, docs/agent-bootstrap-guide.md]
references: [phase-3c-default-facts-extractor, cognitive-handoff-sessions-roadmap]
createdAt: 2026-05-12T23:38:40.866Z
updatedAt: 2026-05-13T00:42:00.000Z
---

# Cognitive handoff sessions

**Status:** shipped in PRs [#104](https://github.com/xpm-cmd/Monsthera/pull/104) + [#105](https://github.com/xpm-cmd/Monsthera/pull/105) + [#106](https://github.com/xpm-cmd/Monsthera/pull/106) + [#107](https://github.com/xpm-cmd/Monsthera/pull/107), merged to `main` on 2026-05-12. **Phase 3c (DefaultFactsExtractor)** shipped 2026-05-13: `facts.json` now hydrates from real repo state (events, work, knowledge, commits, code, diff signals), unlocking grounded citations in handoff articles.
**Module:** `src/sessions/` (new, ~1700 LOC).
**Layer:** sits on top of the existing environmental bootstrap (`docs/agent-bootstrap-guide.md`) as Phase E of the SessionStart hook script.

## Why this exists

Every new agent session previously paid Opus/Sonnet tokens to re-explore the repo from scratch: search knowledge, read `index.md`, inspect work articles. Context compaction made it worse — facts survive but narrative (intent, decisions, next steps) evaporates. The handoff article is an **anti-compaction artifact**, written once by a local Ollama model and read cheaply by every subsequent agent.

Hard target met: **coding agent net budget ≤500 tokens per session** for protocol participation (read teaser at open + optional `--note` at close). Local Ollama absorbs ~3500 in / ~1700 out per session for the actual narrative work.

## Mental model

```
SessionStart hook  →  monsthera CLI  →  src/sessions/  →  reused primitives
(shell)                (`session …`)     (new module)     (events, knowledge, work, code)
```

**Happy path:**
1. Agent opens Claude/Codex in a Monsthera repo → SessionStart hook fires
2. Hook detects agent via env (`CLAUDECODE` → `claude-code`; `CODEX_*` → `codex-cli`; `MONSTHERA_AGENT_ID` override), calls `monsthera session open --teaser-only`
3. Hook emits the teaser under `## Monsthera briefing` heading. Teaser includes a close-protocol hint so the agent knows what to call at the end.
4. Agent works.
5. Agent (on user signal or before compaction) calls `monsthera session close [--note "..."]`. Returns in ~100 ms; a detached worker spawns.
6. Worker runs Stage A (extract `facts.json`) + Stage B+C (Ollama combined retrospect+prospect, JSON-mode + grounding) + Stage D (validate citations, self-eval). Writes a knowledge article with `category=handoff` and attaches it to the session record.
7. Next session start reads the article's TL;DR as the new teaser.

## Three-tier content model (who pays for tokens)

| Tier | Generated content | Who pays | When |
|---|---|---|---|
| **T1** | `facts.json`: events, work, knowledge, code, diffs, signals | Deterministic, zero LLM | Sync at close |
| **T2** | Summary + Decisions + Blockers + Surprises + Deferred + NextSteps + OpenQuestions + SuggestedAgent | **Local Ollama** (`qwen2.5-coder:7b` default) | Async after close |
| **T3** | Optional one-line agent intent via `--note` | **Coding agent** (opt-in; default empty) | Sync at close |

## Architecture

### Module layout

- `src/sessions/schemas.ts` — `Session`, `SessionStatus`, `SessionFacts` + zod validators
- `src/sessions/repository.ts` — `SessionRepository` interface
- `src/sessions/in-memory-repository.ts` — used in tests + degraded mode
- `src/sessions/file-repository.ts` — `<markdownRoot>/sessions/<id>.json` + `<id>.facts.json` sidecar
- `src/sessions/facts-extractor.ts` — Stage A `FactsExtractor` interface + `MinimalFactsExtractor` (in-memory tests, no git) + `DefaultFactsExtractor` (production: orchestrator joining events/work/knowledge/git)
- `src/sessions/facts-extractor-git.ts` — pure git helpers (`resolveBaseSha`, `listCommitsInWindow`, `listCodeTouchedSinceBase`, `extractDiffSignals`) over an injected `CommandRunner`
- `src/sessions/facts-extractor-joins.ts` — pure join helpers (`phaseAt`, `roleOf`, `joinWorkTouched`) over already-loaded repo data
- `src/sessions/llm-summarizer.ts` — `LLMSummarizer` interface + `OllamaSummarizer` (POST `/api/generate` with `format=json`)
- `src/sessions/citation-validator.ts` — `pruneSummaryCitations` strips evidence IDs that don't resolve to `facts.json`
- `src/sessions/handoff-renderer.ts` — validated stages → markdown body (TL;DR + What happened + What's next + Hypergraph + Facts pointer)
- `src/sessions/service.ts` — top-level `SessionService.open/close/get/list` + `generateHandoff` worker entrypoint

### CLI surface

```
monsthera session open     [--agent <id>] [--intent "..."] [--teaser-only] [--json] [--repo <p>]
monsthera session close    [--session-id <id>] [--note "..."] [--no-llm] [--sync] [--json] [--repo <p>]
monsthera session get      <session-id> [--json]
monsthera session list     [--agent <id>] [--status <s>] [--limit <n>] [--json]
monsthera session _generate-handoff <session-id>   # internal — worker subprocess entry
```

### Lifecycle state machine

```
                      monsthera session open
                              │
                              ▼
                       ┌──────────────┐
                       │     open     │
                       └──────┬───────┘
                              │
       ┌──────────────────────┼────────────────────────┐
       │                      │                        │
       │ session close        │ session open (later)   │ session abandon
       ▼                      ▼ for same (agent, repo) ▼ (manual)
  ┌──────────┐          ┌───────────────┐         ┌──────────────┐
  │  closed  │          │   abandoned   │◀────────│  abandoned   │
  │ (handoff │          │  (superseded) │         │   (manual)   │
  │  async)  │          └───────────────┘         └──────────────┘
  └──────────┘
       │
       │ async Ollama finishes
       ▼
   Session.handoffArticleId set
   (terminal — Sessions are immutable post-terminal)
```

**Rules:**
- One open Session per `(agentId, repo)` at most. Next open auto-supersedes via `abandon(reason=superseded)`.
- No `closed → open` transition. To resume, open new Session; `parentSessionId` chains.
- Sessions from *other* agents are never touched by open/abandon.

### Storage

```
<repo>/knowledge/
├── sessions/                                      # NEW
│   ├── ses-<YYYYMMDD-HHMMSS>-<agentId>.json       # lifecycle record (JSON, not Markdown)
│   ├── ses-<...>.facts.json                       # Stage A output (sidecar)
│   └── ...
└── notes/
    ├── handoff-ses-<...>.md                       # rich handoff article (category=handoff)
    └── ...
```

**Deviation from original plan:** Session records are JSON, not YAML-frontmatter Markdown. The existing `knowledge/markdown.ts` serializer is intentionally naive (no nulls, no nested objects). Handoff articles remain Markdown knowledge articles. See class doc in `src/sessions/file-repository.ts`.

### Async dispatch (Phase 3b)

`session close` returns in ~100 ms by spawning a detached subprocess:

```ts
const child = spawn(process.execPath, [tsxLoaderArgs, scriptPath, "session", "_generate-handoff", sessionId, "--repo", repo], {
  detached: true,
  stdio: "ignore",
  env: process.env,
  cwd: scriptDir, // stay in Monsthera project where tsx is resolvable
});
child.unref();
```

In dev (tsx-running, when `argv[1].endsWith('.ts')`), we prepend `--import tsx` so the child registers the loader. In production (compiled `bin.js`), the child runs under plain `node`.

The worker's stdio can be captured to `MONSTHERA_SESSIONS_WORKER_LOG` for debugging.

### Quality safeguards (locked in v1)

1. **JSON-schema constrained output**: Ollama runs with `format: "json"` + the prompt embeds a schema.
2. **Grounding**: every evidence citation (`evt:<id>`, `work:<id>`, `knowledge:<slug>`, `commit:<sha-8>`, `path:<file>:<line>`) must resolve to an entity in `facts.json`. Unresolved citations are pruned by `pruneSummaryCitations` before persisting. The LLM never invents entities — at worst it cites things that get filtered.
3. **Self-eval**: small Stage D prompt rates the article 1-5 on (covers what happened, covers what's next, covers blockers). Score persisted as `Session.quality.score`.
4. **Graceful degradation**: Ollama unreachable → T1-only article persisted with `quality.degraded=true`. The Hypergraph + Facts sections retain value.
5. **Orphan detection**: next `session open` for same `(agent, repo)` checks if the prior closed session has `handoffArticleId === null` (async worker didn't finish). Surfaces `⚠ Previous handoff is incomplete` in the teaser with a recovery command (`monsthera session _generate-handoff <id>`).

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `MONSTHERA_AGENT_ID` | (env auto-detect) | Override agent identity for the SessionStart hook |
| `MONSTHERA_SESSIONS_LLM_ENABLED` | `true` | Disable Stages B/C/D globally (forces T1-only handoffs) |
| `MONSTHERA_SESSIONS_LLM_MODEL` | `qwen2.5-coder:7b` | Ollama model for retrospect+prospect+self-eval |
| `MONSTHERA_SESSIONS_LLM_TIMEOUT_MS` | `60000` | Single-call timeout |
| `MONSTHERA_SESSIONS_WORKER_LOG` | (none) | Capture detached worker stdio for debugging |

All wired in `src/core/config.ts` (`SessionsConfigSchema`) and consumed in `src/core/container.ts` to construct the `OllamaSummarizer` injected into `SessionService`.

## Coverage

- **Tests:** 81 new tests across `tests/unit/sessions/` (5 files). Full suite: **1803/1803 passing**.
- **E2E verified manually:**
  - Real Ollama (`gemma4:latest`): `session close` returns in ~0.9s, worker finishes ~44s later, handoff article rendered with quality score 5/5.
  - `--no-llm`: T1-only article persists, `quality.degraded=true`.
  - Briefing flow: fresh repo → "Starting fresh"; second session → references the previous handoff + close hint.

## Implementation deviations (each documented inline in code)

1. **Session records are JSON, not Markdown+YAML** (`src/sessions/file-repository.ts` class doc).
2. **Stages B and C run as ONE combined Ollama prompt** with a schema covering both fields. The renderer keeps them as distinct sections. Splitting is mechanical if quality demands it. See `buildRetrospectProspectPrompt` in `src/sessions/llm-summarizer.ts`.
3. **No `session_*`/`handoff_*` orchestration events** emitted. `OrchestrationEvent.workId` is required and session events don't always have one. Adding optional `workId` is a wider schema change deferred to a follow-up. The lifecycle is fully reconstructible from `knowledge/sessions/*.json` without events.

## What to know for the next session

### Required to activate end-to-end

The global `monsthera` binary now ships the `session` subcommand (rebuilt + reinstalled between PRs). To verify: `monsthera session --help` should not error.

The user's local `~/.claude/scripts/monsthera-bootstrap.sh` may still be the OLD version (Phases A-D only). Phase E content is in `docs/agent-bootstrap-guide.md` — copy-paste it into the local script.

### YAGNI / explicit non-goals for v1

- No MCP tool wrappers for `session_*` (CLI-first; `src/tools/` untouched)
- No `session brief --depth standard|full` convenience command (`monsthera knowledge get handoff-<id>` works today)
- No `session retry-handoff` repair command (manual recovery via `_generate-handoff`)
- No quality presets `fast` / `high` (only `standard` via configurable model name)
- Cross-machine session sync, session resume/merge/split — not in scope

### Pending follow-ups (prioritized)

**Phase 3c shipped** 2026-05-13: `DefaultFactsExtractor` replaces `MinimalFactsExtractor` in the production container. `facts.json` now hydrates from six joins:
- `OrchestrationEventRepository.findRecent(500)` filtered to `timestamp ∈ [openedAt, closedAt]` and to `agentId === session.agentId || agentId === undefined` (multi-agent isolation).
- `WorkArticleRepository.findById` per unique `workId` in window, hydrating `phaseAtOpen` vs `phaseAtClose` via `phaseAt(history, ts)` and `role` via `roleOf(work, agentId)`.
- `KnowledgeArticleRepository.findMany` filtered to `updatedAt ∈ window` and `category !== "handoff"` (avoid self-reference).
- `git log --format=%H|%s|%cI --since=<openedAt> --until=<closedAt>` for commits (parsed by `listCommitsInWindow`).
- `git diff --numstat <baseSha>..HEAD` for per-file `linesAdded`/`linesRemoved`; binary files are kept with deltas = 0 (`listCodeTouchedSinceBase`).
- `git diff --unified=0 <baseSha>..HEAD` + `TODO|FIXME|XXX|HACK` / `?$` regexes per added line for signals; path and new-file line attributed from `+++ b/<path>` and `@@ +N,M @@` (`extractDiffSignals`).

Git failures (missing binary, not a checkout) degrade to empty arrays so the pipeline never aborts — dogfooded at session `ses-20260513-003933-claude-code` (see `handoff-ses-20260513-003933-claude-code`).

**Medium priority:**
- ADR (`docs/adrs/018-cognitive-handoff-sessions.md`) capturing the Session-as-entity decision, T1/T2/T3 layering, grounding constraint, async dispatch
- `monsthera session brief` convenience command
- MCP tool wrappers (`mcp__monsthera__session_open`, `_close`, `_get`, `_list`, `_brief`)
- Bump `package.json` version (currently still `3.0.0-alpha.7` despite the rebuild) and publish

**Low priority — defer until requested:**
- `session_*`/`handoff_*` orchestration events (requires optional `workId` schema change)
- Quality presets (`--quality fast|standard|high`)
- Cross-handoff coherence check (drift detection between prior nextSteps and current session's work)
- Self-amending enrich (`session enrich-previous --question "..."`)
- Integration test against a real Ollama instance (opt-in)

## Files to read first

- `docs/agent-bootstrap-guide.md` — full operator/agent-facing documentation, including Step 5 (close protocol)
- `~/.claude/plans/me-gusratia-ver-como-cuddly-puppy.md` — the original design plan (still useful for context)
- `src/sessions/service.ts` — the orchestration logic (`open`, `close`, async dispatch, pipeline)
- `src/sessions/llm-summarizer.ts` — the Ollama prompts (the actual schema enforced on the LLM)

## Related work

Sits on top of the agent-bootstrap-guide infrastructure shipped in PR #102. Uses the same SessionStart hook + 30s outer timeout + secret redaction conventions. Reuses `KnowledgeService.createArticle`, `OllamaEmbeddingProvider`'s connection style, and the existing knowledge corpus indexer.
