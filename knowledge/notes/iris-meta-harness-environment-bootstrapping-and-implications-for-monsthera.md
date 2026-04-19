---
id: k-to46fuoi
title: IRIS Meta-Harness — Environment Bootstrapping and Implications for Monsthera
slug: iris-meta-harness-environment-bootstrapping-and-implications-for-monsthera
category: research
tags: [agents, research, terminal-bench, context, bootstrapping, mcp, tools]
codeRefs: [src/context/insights.ts, src/tools/search-tools.ts, src/tools/agent-tools.ts, src/tools/index.ts]
references: []
createdAt: 2026-04-19T07:56:11.759Z
updatedAt: 2026-04-19T08:40:56.238Z
---



Research note comparing Stanford IRIS Lab's `meta-harness-tbench2-artifact` against Monsthera's context model, and proposing an `environment_snapshot` tool so agents using Monsthera get the same cold-start savings the IRIS artifact reports.

## Source

- Upstream repo: `https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact`
- Reported result: 76.4% on Terminal-Bench 2.0 (89 tasks x 5 trials, Claude Opus 4.6)
- Built on Terminus-KIRA (KRAFTON AI) and Harbor's Terminus-2

## What Meta-Harness actually is

A minimal Python agent *harness* (not a platform). Key files:

- `agent.py` — the loop
- `anthropic_caching.py` — ephemeral prompt caching on the last 3 messages
- `prompt-templates/terminus-kira.txt` — base system prompt
- `pyproject.toml`

It exposes 3 tools to the model: `execute_commands`, `task_complete`, `image_read`. The loop is standard (parse tool calls, execute, feed output back, retry on LLM errors, summarize on context overflow).

## The one meaningful novelty — environment bootstrapping

Before the first LLM turn, `_gather_env_snapshot()` (around agent.py:1050-1128) runs a compound shell command that collects:

- working directory (`pwd`)
- file listing (`ls -la /app/`)
- available runtimes (`python3`, `gcc`, `g++`, `node`, `java`, `rustc`, `go`)
- package managers (`pip3`, `pip`, `apt-get`)
- memory (`free -h`)

The result is parsed into sections and injected into the initial user message. Claimed effect: eliminates the 2-5 reconnaissance turns agents typically waste running `ls` / `which python3` / `cat package.json` before producing useful output.

Everything else in the repo is standard agent-harness plumbing. The bootstrap is the ideas-per-byte winner.

## What Monsthera already covers

Monsthera gives agents *semantic* context — persistent, cross-session, multi-agent:

- `build_context_pack` — retrieval of relevant knowledge + work + code refs before deep work
- Knowledge articles — decisions, guides, imported sources
- Work articles — explicit contract (objective, acceptance criteria, owners, references, codeRefs, phase history)
- Waves + guards — safe phase transitions
- Search (hybrid) — discovery over the corpus

This is strictly more than what Meta-Harness does in the "what context goes in the prompt" question.

## What Monsthera does NOT cover

Monsthera has no equivalent of the live-sandbox snapshot. An agent still has to discover:

- which branch is checked out
- which package manager / lockfile is present
- which runtimes are installed in this sandbox
- whether `pnpm install` has been run
- disk / memory headroom

`build_context_pack` answers "what does the project say it is" (semantic). It does not answer "what is actually true in this sandbox right now" (physical). Those answers can drift: the doc says Node 20, the sandbox has Node 22; the ADR references `pnpm` but the container only has `npm`; a past work article mentions a branch that no longer exists.

## Proposed addition — `environment_snapshot` tool

Add a new MCP tool (category: agent-tools) that returns a structured snapshot of the current sandbox. Two design choices worth noting:

### 1. Client-side execution, not server-side shell

The MCP server should NOT spawn shell processes to probe a remote sandbox. Instead the tool takes an already-collected snapshot as input and returns a normalized, validated, token-efficient structure the agent can reference by id. That keeps Monsthera out of the shell-execution business and aligns with the current tool surface.

Rationale: Monsthera is typically hosted separately from the sandbox where the agent runs its commands. The agent already has a shell tool in its own harness. Let the harness call shell; have Monsthera turn raw output into a durable, linkable artifact.

Alternative worth evaluating: a *helper command* (CLI or script) that runs the well-known probes (`pwd`, `ls`, `which`, lockfile detection, `node -v`, `free -h`) and emits JSON the tool then accepts. The tool itself stays shell-free.

### 2. Snapshots as first-class orchestration events

Store snapshots as orchestration events (alongside phase transitions, wave runs). Benefits:

- Trace which environment a work article was actually implemented against
- Detect drift between snapshots when a work article is resumed by a different agent in a different sandbox
- Power guard predicates: `ready_to_implement` can require "snapshot exists AND lockfile is clean AND node major >= 20"

## How this helps agents using Monsthera

1. **Cold-start savings** — same 2-5 turns the IRIS artifact saves, now available to any agent calling Monsthera before starting work.
2. **Semantic + physical context in one pack** — `build_context_pack` can include a recent snapshot alongside knowledge/work, so the prompt covers both "what the project means" and "what this sandbox is".
3. **Smarter guards** — phase advance predicates can consult the snapshot instead of trusting the agent's self-report.
4. **Reliable multi-agent handoffs** — when agent B resumes a work article, comparing the current snapshot to the one recorded at handoff time flags drift (different branch, different Node, missing deps) before B assumes the prior state.
5. **Auditable evidence** — the completed-work record shows the exact environment the implementation was produced against.
6. **Lower token cost** — fewer reconnaissance turns, fewer redundant `ls` / `cat` round-trips, more budget for the actual task.

## Scope boundaries — what this is NOT

- Not a terminal harness. Monsthera does not start a loop, does not execute commands, does not drive Claude turn-by-turn. Agents keep their own harness.
- Not a replacement for `build_context_pack`. Snapshots complement semantic context, they do not replace it.
- Not a benchmark claim. Until Monsthera is measured on something like Terminal-Bench, "better than Meta-Harness" is unfounded. Better *scope* is defensible; better *numbers* is not.

## Open questions to resolve during implementation

- What exact shape should the snapshot take? (Minimal: cwd, files, runtimes, package managers, memory, git ref, lockfile hash.)
- Where should snapshots live? Markdown under `knowledge/snapshots/` vs. Dolt-only event? The latter is cheaper; the former is discoverable.
- TTL — snapshots drift. Should `build_context_pack` refuse snapshots older than N minutes, or just surface the age?
- Who writes them — the agent via the MCP tool, or a CLI helper run as part of `pnpm exec tsx src/bin.ts`?
- Schema validation — reuse Zod with a `SnapshotFrontmatterSchema` alongside existing knowledge / work schemas.

## Next step

See the accompanying work article `w-0ieze72s` for the implementation contract, acceptance criteria, and file plan.

## Implementation status — shipped

The proposal above has been implemented on branch `claude/investigate-iris-artifact-GdxdL` (PR #59). The "Proposed addition" and "Open questions" sections above are preserved as design record; the actual shipped behavior matches them with minor adjustments captured here.

What landed:

- `src/context/snapshot-schema.ts` — Zod schema for snapshot input/storage and the diff shape.
- `src/context/snapshot-repository.ts` + `snapshot-in-memory-repository.ts` — bounded (5k) in-memory repo with oldest-first eviction.
- `src/context/snapshot-service.ts` — `record`, `getLatest`, `compare`. Computes `ageSeconds` + `stale` against `maxAgeMinutes`.
- `src/tools/snapshot-tools.ts` — three MCP tools: `record_environment_snapshot`, `get_latest_environment_snapshot`, `compare_environment_snapshots`.
- `src/tools/search-tools.ts` — `build_context_pack` accepts `agent_id` / `work_id`; attaches a slim `snapshot` field and appends `stale_snapshot` to `guidance` when older than the threshold.
- `scripts/capture-env-snapshot.ts` — client-side probe runner (node, pnpm, git, /proc/meminfo, lockfile sha256). Probe failures omit fields instead of failing.
- Config: `MonstheraConfig.context.snapshotMaxAgeMinutes`, env var `MONSTHERA_SNAPSHOT_MAX_AGE_MINUTES`, default 30, `0` disables.

Design decisions that differ from the original proposal:

- Storage is a dedicated repository, not an orchestration event. Events record facts; snapshots are queryable state, so a separate repo mirrors the existing `knowledge` / `work` / `search` pattern more cleanly.
- Snapshot tools live in their own `snapshot-tools.ts` file instead of inside `agent-tools.ts`. Three tools are enough to deserve a file, and it matches the per-domain tool file convention.
- Stale snapshots are kept and annotated in `guidance` rather than refused. Dropping a stale snapshot would silently remove physical context; annotating lets the agent decide.

Validation: 33 new unit tests (schema, service, MCP tool dispatch, `build_context_pack` integration). Full suite: 1183 passed, 3 skipped. `tsc --noEmit` clean; `pnpm lint` reports only pre-existing errors unrelated to this work.

Next steps still open (separate work, not this one):

- Guard predicates that consume snapshots (e.g. a `ready_to_implement` guard that requires a fresh snapshot with clean lockfile).
- Snapshot diffing in the dashboard when resuming a work article.
- Dolt persistence for snapshots (currently in-memory only).
- Benchmark harness to quantify the savings against a public terminal task set.

## Follow-up work articles

All four "next step" items listed above shipped as dedicated PRs off `main`; none touches the MCP-server-shells-out boundary or the `InMemorySnapshotRepository` contract. Closed out into release `3.0.0-alpha.5` on 2026-04-19. The benchmark spike was cancelled with an audit-recorded reason — the plan is captured, the numbers require a dedicated API-budgeted session.

| Work article | Template | Final phase | Scope | PR |
| :-- | :-- | :-- | :-- | :-- |
| `w-guptmc33` — Dolt persistence for environment snapshots | feature | done (skipGuard) | `DoltSnapshotRepository` + `environment_snapshots` table + container wiring; snapshots survive restarts when `doltEnabled`. | [#60](https://github.com/xpm-cmd/Monsthera/pull/60) |
| `w-y988ky96` — Opt-in `snapshot_ready` guard | feature | done (skipGuard) | Async guard layer (`AsyncGuardEntry`, `evaluateAsyncGuards`), `snapshot_ready` guard gating `enrichment → implementation` for opted-in templates (only `FEATURE` by default), ADR-006. | [#61](https://github.com/xpm-cmd/Monsthera/pull/61) |
| `w-r85lzqhv` — Dashboard snapshot-diff endpoint & drift band | feature | done (skipGuard) | `GET /api/work/:id/snapshot-diff?against=<id>` + expanded-card drift banner for phase `implementation` / `review`. | [#62](https://github.com/xpm-cmd/Monsthera/pull/62) |
| `w-uvp3azdf` — Benchmark spike (methodology + target results) | spike | cancelled | Measurement plan for the cold-start savings claim; methodology lives in the companion knowledge article `k-pwksnl38`. Cancelled: the bench requires an API-budgeted session to run; the methodology survives and a future session can pick it up without re-designing. | [#63](https://github.com/xpm-cmd/Monsthera/pull/63) |
| `w-ksaf2rcr` — Agent-facing docs + recovery hints | refactor | done (skipGuard) | `AsyncGuardEntry.recoveryHint?`, `snapshot_ready` hint pointing at the capture helper + `skipGuard`, "Environment snapshots" section on the agent operating guide `k-uuz80fga`. | [#64](https://github.com/xpm-cmd/Monsthera/pull/64) |

`done (skipGuard)` means the article advanced `review → done` with the `all_reviewers_approved` guard bypassed; the bypass name + reason are recorded in each article's phase history per the Tier 2.1 audit-trail contract. No external reviewer participated in this session; future work should not copy this pattern if an external reviewer is available.

The benchmark methodology is captured in a sibling research note: `k-pwksnl38` — "Benchmark Methodology — Environment Snapshot + `build_context_pack` Impact". It is the playbook; if a future session runs the bench, the results land on a new work article referencing `k-pwksnl38` and this note.

## CLI UX follow-ups (post-alpha.5)

Using the alpha.5 surface live during its own close-out exposed six separate friction points that weren't design flaws — they were the CLI's edges scraping against real agent workflows. Every one was cheap to fix once the session had already typed the painful version. Shipped as Tier 6 on 2026-04-19 (release `3.0.0-alpha.6`).

| Friction | Fix | PR |
| :-- | :-- | :-- |
| Shell heredoc corrupted backticks in `--content "$(cat <<'EOF' ... EOF)"` (visible on `w-r85lzqhv`, `w-uvp3azdf`). | `work create` / `work update` gain `--content-file <path>` (verbatim disk read) and `--edit` (opens `$EDITOR`, seeded with `generateInitialContent(template)` on create). Three input modes, mutually exclusive. | [#66](https://github.com/xpm-cmd/Monsthera/pull/66) |
| Closing a merged work article was a four-flag incantation; the same `review → done` skipGuard string was typed six times this tier. | `work close <id>` delegates to `advancePhase(id, DONE, { skipGuard: { reason } })` with the reason sourced from either `--pr <n>` (canonical) or `--reason <text>` (custom). | [#67](https://github.com/xpm-cmd/Monsthera/pull/67) |
| End-to-end `record_environment_snapshot + build_context_pack` required a throwaway `scripts/probe.ts` in the same container; written + deleted three times during alpha.5. | `monsthera pack <query...>` subcommand reusing `handleSearchTool("build_context_pack", ...)`; optional `--record <path>` or `--record -` for stdin snapshots; `--json` for machine output. | [#68](https://github.com/xpm-cmd/Monsthera/pull/68) |
| When `work_id` was set, `build_context_pack` ranked the caller's own article at #1, wasting the top slot. | `exclude_ids: string[]` opt-in filter on `build_context_pack` (service + MCP tool). `work_id` does not auto-exclude — callers pass `[work_id]` explicitly to free the slot. Compat unchanged. | [#69](https://github.com/xpm-cmd/Monsthera/pull/69) |
| Every alpha.5 PR shipped with 16 "lint parity with main" pre-existing issues as dead freight in the PR description. | `pnpm lint` exits 0: inline `import()` types replaced with `import type`, unused test imports dropped, `as any` on the wiki-bookkeeper log stub typed properly, Ollama-gated integration-test logs given a scoped `eslint-disable no-console` with a reason. | [#70](https://github.com/xpm-cmd/Monsthera/pull/70) |
| `work list` / `knowledge list` emit a human-readable table agents can't parse — agents re-queried via MCP for structured data. | `--json` flag on both commands: `JSON.stringify(result.value, null, 2)`. Default table output unchanged. | [#71](https://github.com/xpm-cmd/Monsthera/pull/71) |

These six PRs were landed off `main` in parallel — none touches the MCP-server-shells-out boundary, the `InMemorySnapshotRepository` contract, the 30-minute snapshot-staleness default, or the compat shape of `build_context_pack`. No external reviewer participated; closures use the new `work close` command built in this same tier (#67) — self-hosting — and each bypass reason is recorded in phase history per the Tier 2.1 audit contract.

The pattern is worth recording: the friction in each of these six items was invisible until we used the surface ourselves, and each was a tiny commit once typed. The takeaway for Tier 7+ is simple — "dogfood every tier before closing it," which is exactly what the IRIS meta-harness thesis predicts will matter.