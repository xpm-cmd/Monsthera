---
id: k-1ps6iyqf
title: ADR-019: Agent-direct handoff (reversal of ADR-018 D2/D3)
slug: adr-019-agent-direct-handoff-reversal-of-adr-018-d2d3
category: architecture
tags: []
codeRefs: [src/tools/session-tools.ts]
references: []
sourcePath: docs/adrs/019-agent-direct-handoff.md
createdAt: 2026-06-10T09:08:32.890Z
updatedAt: 2026-06-10T09:08:32.890Z
---

# ADR-019: Agent-direct handoff (reversal of ADR-018 D2/D3)

**Status:** Accepted
**Date:** 2026-05-17
**Decision makers:** Architecture team
**Supersedes:** ADR-018 D2 (three-tier content model) and D3 (local Ollama for narrative tier) — see "Decision" below for the precise extent of the reversal.
**Driven by:** empirical evidence from 12 handoffs produced under ADR-018 + a cold-start subagent utility test (2026-05-17).

## Context

ADR-018 locked the cognitive-handoff-sessions architecture around a three-tier content model: deterministic facts (T1) extracted by Stage A, LLM-generated narrative (T2) produced by a local Ollama model during async Stages B/C/D, and an optional one-line agent intent (T3) supplied at close time. The rationale was token discipline — Claude/Codex tokens are expensive, local Ollama tokens are free, so the cheap producer writes the durable artefact.

Four rounds of dogfood calibration (PRs [#109](https://github.com/xpm-cmd/Monsthera/pull/109), [#112](https://github.com/xpm-cmd/Monsthera/pull/112), [#113](https://github.com/xpm-cmd/Monsthera/pull/113)) tightened the LLM prompt, broadened the coverage validator's heuristics, and added structural fixes (always-emit `### Blockers`, anchor the `## Facts` strip). Self-eval scores converged on 4–5/5 across the corpus. But the cold-start utility test — a fresh subagent given ONLY a handoff and asked whether it could execute — verdict was 2/5, with two real findings:

1. **Sort behavior, filter contract, TDD step** were absent from the handoff because they were absent from the `--note`. The LLM expanded the note 2.7× with structural prose but did not (and could not) add knowledge that was never in the input.
2. **File:line refs were not pinned to a commit SHA**, so when the underlying code drifted between handoff write and reader read, the reader (the cold-start subagent) silently consumed stale references and reasoned from them.

The empirical comparison between the agent's note (1331 chars, contained most of the technical specifics) and the rendered handoff (3544 chars) showed the LLM was reformatting, not synthesising. A 3× larger local model (gemma4:26b) was tested as a control — it timed out (>200 s on a trivial prompt) and never produced a usable handoff on the test hardware. The bottleneck was confirmed to be the `agentNote` field's information content, not the LLM's expansion capability.

The cross-session token math reframes the optimisation target. ADR-018's "≤500 tokens net per session" budget was per-close. The next session's reader pays 10 000–30 000 Claude tokens re-deriving context when the handoff is under-specified. Saving ~1 500 close-time tokens by shipping a sparse note costs ~15 000 read-time tokens. Net: −10× across the conversation chain.

## Decision

The executing agent (Claude, Codex, etc.) writes the substantive handoff body directly. The local-Ollama pipeline (Stages B/C/D) is no longer the default producer.

### D1. Add `session close --content[-file]` as the preferred close path

`monsthera session close --content-file <path>` (or `--content <inline-markdown>`) takes a complete handoff body authored by the executing agent. The CLI persists it verbatim, prepended with the deterministic header and followed by the deterministic `## Hypergraph` + `## Facts (raw, for downstream LLM)` sections. No LLM call. The MCP `session_close` tool gains a matching `content` parameter (`src/tools/session-tools.ts`).

The split between agent-authored and CLI-authored sections is intentional. The agent shouldn't have to know session metadata (id, agent id, duration, parent pointer, quality fields) — that's deterministic and the CLI owns it. The agent shouldn't have to enumerate `Hypergraph` (commits, work touched, code touched) — that's derived from Stage A's facts.json and would only duplicate or contradict it. Everything between is content only the agent — with its full session context — can produce well.

### D2. Stage A (facts extraction) is unchanged; Stages B/C/D are deprecated, not removed

`facts.json` continues to be extracted synchronously at close time (deterministic, cheap, useful regardless of writer). It still hydrates the `agentNote` field when `--note` is supplied (now legacy), and remains the grounding source for both the validator and any future cross-handoff coherence checks. Stage A is load-bearing.

The Ollama-based Stages B/C/D — `buildRetrospectProspectPrompt`, `buildSelfEvalPrompt`, `OllamaSummarizer`, `runHandoffPipeline`, the async worker subprocess (`_generate-handoff`) — are kept in-tree and continue to work for any caller passing `--note` without `--content`. They are marked **DEPRECATED** in the CLI help text, the MCP tool description, the agent-bootstrap-guide, and the CLAUDE.md snippet. Planned removal: 3.1, after a one-minor-version migration period.

### D3. New `quality.writer` field on Session records

`SessionQuality` gains `writer: "ollama" | "agent"`. For legacy LLM closes, `writer="ollama"` and `model` carries the LLM name (e.g. `gemma4:latest`). For agent-direct closes, `writer="agent"` and `model` carries the `agentId` (e.g. `claude-code`, `codex-cli`). `score` is null in the agent-direct path (no LLM self-eval); `degraded` is always false (the body was explicitly authored). Backward compatibility: the field defaults to `"ollama"` on persisted records that predate the schema change.

### D4. Coverage validator stays as an advisory pass

`evaluateHandoffCoverage` runs against the assembled article body regardless of writer. When gaps are found, the `## Coverage` section is appended unchanged. This preserves the operator-facing quality signal across both paths. An agent-written body that omits a verification command will still be flagged — the validator catches both LLMs and humans.

### D5. Sync, not async

Agent-direct closes are always synchronous. There is no LLM call to defer, no worker subprocess to spawn, no orphan failure mode. `--sync` is ignored when `--content` is provided. Close returns in single-digit seconds (the time to render + persist + reindex), not the ~100 ms the async LLM path achieves; this is acceptable because the agent is generally about-to-exit anyway.

## Consequences

- **Handoff quality is bounded by the agent's writing, not by an LLM expansion ceiling.** The executor has the full session context; the only ceiling is what it chooses to surface. Empirical expectation (to be validated by the round-7 cold-start test bundled with this PR): a Claude-authored handoff scores 4–5/5 on the same utility rubric where the gemma4-rendered handoff scored 2/5.
- **Token economy reverses.** ~1 500 extra Claude tokens at close; ~10 000–30 000 fewer at next open. Net negative spend across the conversation chain.
- **Operationally simpler.** No Ollama dependency on the close path. No worker subprocess management. No degraded mode (Ollama unavailability does not exist as a concept for agent-direct closes). No timeout calibration for varying model sizes.
- **Heterogeneous voice across agents.** Claude-rendered and Codex-rendered handoffs read differently. This is acceptable — `quality.writer` + `quality.model` (the agentId) lets operators trace authorship.
- **The `--note` field is now grounding-only.** When provided alongside `--content`, it is persisted to `facts.agentNote` (used by the validator and by future cross-handoff coherence checks) but does not influence the rendered body. When provided without `--content`, the legacy LLM path still runs and surfaces it in the prompt.
- **Sessions persisted before this change** continue to load correctly. `quality.writer` defaults to `"ollama"` when absent from the on-disk record.

## Why we keep the LLM path in-tree (for now)

- Some operators may want the LLM path as a fallback when an automation closes the session without a writing-agent in scope (e.g. a cron task that triggers `session close` on an abandoned session).
- The async-dispatch + orphan-detection machinery (`generateHandoff`, `tryDispatchWorker`, `previousOrphan` warning surfaced in the teaser) is exercised by tests and has earned its keep through multiple bug fixes. Removing it without a migration window would risk regressions.
- The empirical reversal is recent (single PR, single dogfood cycle). Allowing both paths to coexist for a minor version gives external consumers time to migrate.

Planned removal in 3.1: drop `OllamaSummarizer`, `buildRetrospectProspectPrompt`, `buildSelfEvalPrompt`, the worker spawn machinery, and the `MONSTHERA_SESSIONS_LLM_*` env vars. `quality.writer` becomes always-`"agent"` for new closes; the legacy enum value remains for read-side backward compatibility with old records.

## Implementation deviations (each documented inline)

1. **`Session.repo` normalization is NOT in this PR.** The cross-worktree parent fix (commit `ef5162d`) widened `SessionService.open`'s parent-lookup filter to agentId-only; this PR doesn't otherwise touch `Session.repo` semantics. Worth a follow-up to normalize at write time (use `git rev-parse --git-common-dir`'s parent), but orthogonal to ADR-019.
2. **`quality.writer` is enum, not free-form.** Restricted to `"ollama" | "agent"` for type safety. Future granularity (`"claude-code"`, `"codex-cli"`) lives in `quality.model` for the agent path — it carries the agentId.
3. **Coverage section is appended to the AGENT body, not interspersed.** When the agent writes `## TL;DR` + `## What happened` + `## What's next` and the validator finds gaps, `## Coverage` lands AFTER `## Facts (raw, for downstream LLM)`. Reason: structural append is simpler and matches the legacy path's behaviour.

## References

- ADR-018: cognitive handoff sessions (the architecture this ADR amends)
- Empirical cold-start subagent utility test (2026-05-17 dogfood session in the same PR)
- Knowledge note `coverage-validator-round-4-calibration.md` for the rounds-4-through-6 calibration history
- PR introducing this ADR + implementation: tracked separately