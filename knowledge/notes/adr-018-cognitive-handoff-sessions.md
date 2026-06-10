---
id: k-1s76awex
title: ADR-018: Cognitive handoff sessions
slug: adr-018-cognitive-handoff-sessions
category: architecture
tags: []
codeRefs: [docs/agent-bootstrap-guide.md, knowledge/notes/cognitive-handoff-sessions.md, src/sessions/coverage-validator.ts, knowledge/index.md, src/sessions/file-repository.ts, src/sessions/llm-summarizer.ts, knowledge/notes/coverage-validator-round-4-calibration.md]
references: []
sourcePath: docs/adrs/018-cognitive-handoff-sessions.md
createdAt: 2026-06-10T09:08:31.538Z
updatedAt: 2026-06-10T09:08:31.538Z
---

# ADR-018: Cognitive handoff sessions

**Status:** Accepted
**Date:** 2026-05-16
**Decision makers:** Architecture team
**Supersedes:** none. Extends the environmental bootstrap layer documented in `docs/agent-bootstrap-guide.md` (PR [#102](https://github.com/xpm-cmd/Monsthera/pull/102)) with a new cognitive bootstrap layer.

## Context

Monsthera coordinates multiple AI coding agents (Claude Code, Codex CLI, Codex desktop) over a shared knowledge corpus and work-article backlog. Before this ADR, every new agent session paid Opus/Sonnet tokens to re-derive context from scratch: search knowledge, read `index.md`, inspect work articles, run `git log` to understand the recent diff. The cost was three-fold:

- **Token-expensive** — re-reading raw history on every session start eats budget that should fund actual work.
- **Lossy across compaction** — when a long-running session is compacted, facts survive but narrative (intent, decisions, watch-outs) evaporates. A summarised conversation has no recoverable "why".
- **Coordination-blind** — `claude-code` cannot see what `codex-cli` did while it was away. Cross-agent visibility lives only in raw event logs which are too noisy for cold-start consumption.

The environmental bootstrap layer (PR [#102](https://github.com/xpm-cmd/Monsthera/pull/102), `docs/agent-bootstrap-guide.md`) already runs at SessionStart to surface infrastructure state (missing `node_modules`, version drift, Dolt down). What was missing was a **cognitive** bootstrap layer on top: a persisted narrative artefact produced at session close, surfaced as a brief teaser at the next session's start, that gives the incoming agent precise, well-articulated, verifiable, actionable context — paid for almost entirely by a local Ollama model, with the coding agent contributing roughly 300–500 tokens net to participate in the protocol.

This ADR formalises the architecture shipped across PRs [#104](https://github.com/xpm-cmd/Monsthera/pull/104) – [#107](https://github.com/xpm-cmd/Monsthera/pull/107) (core lifecycle, facts extractor, LLM pipeline, renderer, citation validator), [#108](https://github.com/xpm-cmd/Monsthera/pull/108) (Phase 3c — `DefaultFactsExtractor` against real repo state), and [#109](https://github.com/xpm-cmd/Monsthera/pull/109) (Phases 3d/3e — repo-layer window filters; Phases 4a/4b — `session brief` CLI + MCP wrappers; coverage validator + four rounds of dogfood calibration). The implementation details live in `knowledge/notes/cognitive-handoff-sessions.md` and the four shipping-learnings notes; this ADR locks the **decisions** the implementation depends on.

## Decision

Cognitive handoffs are a new first-class subsystem under `src/sessions/`. Sessions are persisted entities that live alongside work-articles and knowledge in the workspace's knowledge directory. Handoff articles are normal knowledge articles with `category: "handoff"`, written by a local Ollama model post-close, surfaced at the next session's start.

The full set of locked decisions follows. Each is motivated by a constraint the system must respect: **token cost discipline**, **grounding** (no LLM invention), **graceful degradation** (the LLM pipeline is not load-bearing), and **separation of agent identity from session identity** (one open Session per `(agentId, repo)`).

### D1. Sessions are first-class entities — not events, not work-articles

A Session is its own type with a JSON-frontmatter lifecycle record in `knowledge/sessions/<id>.json` and a corresponding facts.json sidecar. It is not a tag on existing work-articles, not a synthetic projection over events, not a knowledge article subtype.

The rejected alternatives all collapse a meaningful distinction:

- **Work-article subtype.** A work-article tracks a unit of intent that may span agents, sessions, and weeks. A Session tracks "one agent's stretch of attention in one repo." Conflating them would mean every short session creates a work-article (noise) or some sessions secretly contribute to multiple work-articles (loss of provenance).
- **Synthetic projection over events.** Reconstructing session boundaries from `OrchestrationEvent` rows is mechanically possible but loses the lifecycle semantics — abandon-on-supersede, parentSessionId chains, immutability post-terminal — and tightly couples sessions to the orchestration event schema.
- **Knowledge article subtype.** Handoff *articles* are knowledge articles (good — they inherit search, embeddings, wiki bookkeeping). The Session *record* is operational state, not knowledge. Bundling both as knowledge articles would force operational state through the FTS+semantic pipeline, which is expensive and pointless.

Sessions and handoff articles are linked by `Session.handoffArticleId` (FK to knowledge slug). Resume flow uses `parentSessionId` to chain sessions; there is no `closed → open` transition.

### D2. Three-tier content model: deterministic facts, LLM narrative, agent intent

Every handoff is composed from three tiers, each with a different "who pays for tokens" answer:

| Tier | Generated content | Who pays | When |
|---|---|---|---|
| **T1** | `facts.json`: events, work, knowledge, code, diffs, signals | Deterministic, zero LLM | Sync at `session close` |
| **T2** | TL;DR, What happened, Decisions, Blockers, Surprises, Deferred, NextSteps, OpenQuestions, SuggestedAgent | **Local Ollama** | Async after close |
| **T3** | Optional one-line `--note` from the agent at close | **Coding agent** (opt-in; default empty) | Sync at close |

The tier split is the load-bearing decision for cost discipline. The coding agent contributes at most a one-line `--note` (~50–100 tokens) and reads a ~200-token teaser at the next open. Ollama pays ~3500 in / ~1700 out per session for the narrative. The hard target — coding-agent net ≤ 500 tokens per session — held through four rounds of dogfood calibration.

T1 is the durable artefact. T2 can be re-rendered against a new model. T3 is the only place the agent's own judgement enters the pipeline.

### D3. Local Ollama for the narrative tier, JSON-mode schema-constrained

Stages B (retrospect), C (prospect), and D (self-eval) all run against a local Ollama instance. Stages B and C are combined into a single call with a JSON schema covering both fields; stage D is a separate small-prompt rating call against the combined output. Default model is `gemma4:latest`, swappable via `MONSTHERA_SESSIONS_LLM_MODEL`.

Two specific properties of this choice matter:

- **Ollama runs with `format: "json"` plus a prompt-embedded schema.** Output is parsed against a Zod schema (`LLMSummarySchema`); responses that don't match the schema are treated as errors and the article falls back to T1-only. This makes the LLM output predictable enough to feed a deterministic renderer.
- **Stages B and C are combined**, not separated as in the original plan. JSON-mode handles multi-field structured output well, and one round-trip per close halves latency. The renderer still surfaces the two as distinct sections in markdown, so the conceptual separation is preserved at the output layer. Splitting back into two prompts is a mechanical refactor if quality variance demands it.

Local Ollama is the right tier because it can pay tokens at zero marginal cost, latency is acceptable for an async dispatch (see D5), and the privacy properties of running on the user's machine match Monsthera's "no telemetry by default" stance.

### D4. Grounding: every citation must resolve to facts.json

The LLM cannot invent entities. Every evidence citation it emits (`evt:<event.id>`, `work:<workId>`, `knowledge:<slug>`, `commit:<sha-8>`, `path:<file>` or `path:<file>:<line>`) is validated post-generation by `pruneSummaryCitations` against the facts payload that was the prompt's input. Unresolved citations are dropped; the LLM's claim survives only the part of itself that resolves to real data.

This is the load-bearing decision for trustworthiness. Without grounding, an LLM-generated narrative is plausible-sounding fiction — useful for vibes, useless for action. With grounding, the narrative is constrained to facts the deterministic Stage A already extracted from the repo, and the LLM's degrees of freedom are limited to *how* it surfaces those facts (TL;DR phrasing, decision summarisation, what to flag as a blocker vs a deferred item).

Citation validation runs unconditionally — the agent and operator cannot disable it. Disabling grounding would silently let invented entities through into a knowledge corpus that other agents trust.

### D5. Async dispatch — `session close` returns in ~100 ms

`session close` does the T1 work synchronously (extract facts, persist Session record, emit `session_closed` event) and spawns a detached subprocess for T2 (Ollama summarise + self-eval) and the markdown render. The caller returns to the agent immediately; the LLM pipeline runs in the background and writes the handoff article when it finishes (typically ~30–60 s later for a medium-sized session).

The spawn uses `child_process.spawn` with `detached: true`, `stdio: "ignore"`, and `child.unref()` so the parent process can exit cleanly. In dev (`argv[1].endsWith('.ts')`), the child is invoked with `--import tsx` so the loader is available. In production (compiled `dist/bin.js`), the child runs under plain `node`. Worker stdio can be captured to `MONSTHERA_SESSIONS_WORKER_LOG` for debugging.

The async dispatch is what makes the protocol cheap enough to be unconditional. A blocking 30-second close would either lose the protocol (agents skip closing) or block the agent's exit path; an async close is invisible to the agent's perceived cost.

The orphan failure mode — async worker crashes before persistence — is detected at the *next* `session open` for the same `(agent, repo)` pair: if the prior closed Session has `handoffArticleId === null`, the teaser surfaces `⚠ Previous handoff is incomplete` and points at the recovery command (`monsthera session _generate-handoff <id>`).

### D6. Coverage validator: advisory five-question cross-check

Stage D produces a 1–5 quality score via a small LLM-eval prompt, but the score is based on count proxies (`decisionCount`, `blockerCount`, `nextStepCount`, `hasSuggestedAgent`). Those proxies correlate with quality but don't directly answer what a cold-start agent actually needs.

The **coverage validator** (`src/sessions/coverage-validator.ts`, shipped in PR #109's commit `38d4587` with three follow-up calibration commits) is a mechanical, complementary cross-check. It inspects the rendered handoff markdown body against five questions:

1. **Where am I?** (state — Hypergraph section or commit:<sha> citations)
2. **Why are we here?** (intent — explicit `> Intent:` preamble line)
3. **What do I do next?** (executable action — file:line or CLI command, backticked or bare-prose with high-specificity suffix)
4. **What must I not break?** (constraints — Blockers/Deferred/Open questions section or keyword prose)
5. **How do I verify?** (verification — `pnpm test ...`, `monsthera doctor`, etc., backticked or bare with argv-shaped suffix)

Unanswered dimensions are appended as a `## Coverage` section to the article body — transparent self-criticism the next agent can read. The validator is purely advisory: it never blocks persistence or affects the LLM-eval score. It catches a failure mode the LLM-eval cannot see: when the LLM elides specificity (e.g. drops `pnpm test tests/...` in favour of "the dedicated unit tests") even from a rich agent `--note`.

The validator and the LLM-eval are deliberately redundant signals. The eval rates the structure (counts); the validator rates the content (presence of grounded specifics). Either alone would miss real quality issues; together they catch both kinds.

### D7. Graceful degradation is a first-class output mode

When Ollama is unreachable (binary missing, daemon down, model not pulled), the close pipeline does not fail. It persists a T1-only article with `quality.degraded=true` and `quality.score=null`. The Hypergraph section retains its full value (commits, code touched, work transitions); only the narrative sections (TL;DR, What happened, What's next) are reduced to placeholder text directing the reader to the Hypergraph and facts.json.

Degraded mode is not an error to recover from. It is a valid handoff shape that callers handle deterministically:

- `session brief` renders a degraded article through the same depth-slicing path, just with thinner sections.
- The teaser at next open says "degraded (Ollama unavailable)" so the next agent knows the limitation up front.
- Orphan detection still fires correctly — a degraded article is `handoffArticleId !== null`, distinguishing "Ollama down" from "worker crashed mid-write".

This decision generalised through the feature: every read-side artefact — brief, teaser, coverage section — treats degraded modes as first-class outputs, not error states. The pattern recurs in `renderOrphanBrief` for sessions whose async worker never finished.

## Consequences

- **Token budget held.** Across four rounds of dogfood (PRs #104–#109), the coding agent's per-session net token cost stayed under the 500-token target. Ollama absorbs the bulk of the work at zero marginal cost.
- **Sessions are immutable post-terminal.** Once a Session reaches `closed` or `abandoned`, neither the lifecycle record nor the handoff article can be re-written through the service. Resume flow opens a new Session with `parentSessionId` set; re-summarisation is a manual repair via `_generate-handoff`.
- **One open Session per `(agentId, repo)` at most.** A second `open` for the same pair auto-abandons the first with reason `superseded`. Cross-agent isolation: sessions from *other* agents are never touched by the current agent's open/abandon.
- **No new orchestration event types in v1.** `session_*` and `handoff_*` events are deferred — `OrchestrationEvent.workId` is required and session events don't always have one. The lifecycle is fully reconstructible from `knowledge/sessions/*.json` alone. Adding optional `workId` is a wider schema change deferred until call sites demand event-stream visibility for sessions.
- **Knowledge corpus inherits handoff articles automatically.** No new search infrastructure: handoffs are normal knowledge articles with `category: "handoff"`, indexed by FTS+semantic, surfaced by `monsthera knowledge search`, navigable via `knowledge/index.md`. The wiki bookkeeper picks them up on auto-rebuild.
- **MCP surface mirrors the CLI.** Five tools (`session_open`, `session_close`, `session_get`, `session_list`, `session_brief`) wrap the same `SessionService` end-to-end. Agents reasoning from inside an MCP-connected runtime use the same primitives as humans on the CLI.
- **Coverage validator becomes the iteration substrate.** Four calibration rounds in PR #109 each shipped 1–3 validator/renderer/prompt adjustments with dogfood-evidence handoff articles bundled. The pattern — discover via dogfood → fix in one commit pair → bundle the evidence — is now documented and reusable for future feature additions to sessions.

## Implementation deviations from the original plan

The original brainstorm plan (`~/.claude/plans/me-gusratia-ver-como-cuddly-puppy.md`) anticipated some design choices that the shipping implementation deviated from. Each deviation is documented inline at the call site; this section lists them for ADR-level discoverability.

1. **Session records are JSON, not Markdown + YAML frontmatter.** The plan suggested Markdown for consistency with knowledge articles. The shipping implementation discovered that the existing `knowledge/markdown.ts` serializer is intentionally naive (no nulls, no nested objects), and Session records have both. JSON is the right shape; Markdown is reserved for handoff *articles*, which fit the simpler serializer constraints. See class doc in `src/sessions/file-repository.ts`.

2. **Stages B and C combined into one Ollama call.** The plan separated retrospect (B) and prospect (C) into two prompts. Ollama JSON-mode handles multi-field output well, and one round-trip per close halves latency. The renderer still emits them as distinct sections. Splitting is a mechanical refactor if quality variance demands it. See `buildRetrospectProspectPrompt` in `src/sessions/llm-summarizer.ts`.

3. **No `session_*` / `handoff_*` orchestration events emitted.** Deferred (see Consequences above). The lifecycle is reconstructible from `knowledge/sessions/*.json` alone; events are an optimisation for streaming consumers, not load-bearing for correctness.

4. **`renderWhatHappened` always emits `### Blockers` heading.** Shipped in PR #109's round 4 calibration (commit `d49ad24`). When the LLM returns `blockers: []`, the renderer adds `_(none identified)_` rather than skipping the section. This is the renderer enforcing "(none) is more useful than silence" without contradicting the LLM's no-invention rule. The validator credits the heading; the next agent sees that the previous agent actively checked.

5. **Coverage validator strips the structural Facts pointer from scope.** Shipped in PR #109's round 4 calibration (commit `e3d34f1`). The validator's `hasExecutableAction` regex was previously matching every non-degraded handoff via the backticked `.facts.json` filename. `evaluateHandoffCoverage` now slices everything from `## Facts` onward before evaluating. The Facts pointer is a navigation artefact, not an action.

## References

- Implementation index: [`knowledge/notes/cognitive-handoff-sessions.md`](../../knowledge/notes/cognitive-handoff-sessions.md)
- Round 4 calibration learnings: [`knowledge/notes/coverage-validator-round-4-calibration.md`](../../knowledge/notes/coverage-validator-round-4-calibration.md)
- Phase shipping notes: `phase-3c-`, `phase-3d-3e-`, `phase-4a-4b-shipping-non-obvious-learnings.md` under `knowledge/notes/`
- Original brainstorm: `~/.claude/plans/me-gusratia-ver-como-cuddly-puppy.md`
- Agent-bootstrap base layer: [`docs/agent-bootstrap-guide.md`](../agent-bootstrap-guide.md)
- PRs: [#104](https://github.com/xpm-cmd/Monsthera/pull/104) (core), [#105](https://github.com/xpm-cmd/Monsthera/pull/105) (close protocol), [#106](https://github.com/xpm-cmd/Monsthera/pull/106) (rendering fix), [#107](https://github.com/xpm-cmd/Monsthera/pull/107) (open/resume protocol), [#108](https://github.com/xpm-cmd/Monsthera/pull/108) (Phase 3c — DefaultFactsExtractor), [#109](https://github.com/xpm-cmd/Monsthera/pull/109) (Phases 3d/3e/4a/4b + coverage validator + round 4 calibration)