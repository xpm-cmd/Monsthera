---
id: w-dzur84o8
title: Observational benchmark: Monsthera retrieval paths vs. grep
template: spike
phase: done
priority: medium
author: agent-claude-tier6
tags: [benchmark, observation, retrieval, cli, followup, iris-research]
references: []
codeRefs: []
dependencies: []
blockedBy: []
createdAt: 2026-04-20T00:28:00.427Z
updatedAt: 2026-04-20T00:28:30.009Z
enrichmentRolesJson: {"items":[]}
reviewersJson: {"items":[]}
phaseHistoryJson: {"items":[{"phase":"planning","enteredAt":"2026-04-20T00:28:00.427Z","exitedAt":"2026-04-20T00:28:21.646Z"},{"phase":"enrichment","enteredAt":"2026-04-20T00:28:21.646Z","exitedAt":"2026-04-20T00:28:30.009Z"},{"phase":"done","enteredAt":"2026-04-20T00:28:30.009Z"}]}
completedAt: 2026-04-20T00:28:30.009Z
---

## Objective

Capture an observational data point comparing retrieval paths over the Monsthera corpus — semantic `build_context_pack`, BM25 `search`, `get_article`, MCP `get_neighbors`, and raw `grep` — so the formal benchmark plan in `k-pwksnl38` has an anchoring real-session reference before the full A/B runs.

This is **not** a benchmark result. It is a single-session observation with n=2 queries, no trial structure, and wall-clock latency only. The "2–5 reconnaissance turns saved" claim in `k-to46fuoi` remains untested pending the work in `k-pwksnl38`.

## Research Questions

1. Which retrieval path gives the fewest total turns to a useful answer for "how does this subsystem work" queries?
2. Which retrieval path gives the fewest total turns for "what is the exact string/flag" queries?
3. Are there corpus gaps that systematically favour `grep` over Monsthera? (Answer observed here: yes — any code surface not yet written up as a knowledge article.)
4. Does `pack --include-content` justify its extra ~500 ms over `search + get_article` on a per-query basis?

## Observed data (2026-04-20 session, post-alpha.6)

Five retrieval methods × two queries. Latency is wall-clock for a single call; token counts were not recorded.

### Q1: "How does the `snapshot_ready` guard work?"

| Method | Latency | What it returned |
| :-- | :-- | :-- |
| `exec grep` | ~150 ms | 8 file paths containing the string; no narrative |
| MCP `search` | ~300 ms | ADR-006 top-ranked (score 10.0), title + snippet |
| MCP `get_article` | ~400 ms | Full ADR-006 body (~3 KB markdown) |
| MCP `build_context_pack` + `include_content` | ~800 ms | 3 ranked articles with full bodies inlined; ADR-006 score 12.7 |
| MCP `get_neighbors` | ~300 ms | 14 edges to related ADRs; useful for navigation, not answers |

### Q2: "What is the exact `work close` CLI syntax?"

| Method | Latency | What it returned |
| :-- | :-- | :-- |
| `exec grep` on `src/cli/` | ~100 ms | Exact line: `"work close requires --reason <text> or --pr <number>"` |
| MCP `search` | ~300 ms | IRIS research note top-ranked (score 5.6) — did **not** surface the CLI |
| MCP `get_article` on a related work article | ~400 ms | `work advance --phase done --skip-guard-reason` (the pre-Tier-6 pattern, not the new shortcut) |
| `grep` for `"work close"` in `src/cli/` | ~100 ms | Canonical syntax |

## Findings

1. **Narrative queries → `pack`.** Q1 is `pack`'s sweet spot. A single 800 ms call returns three ranked articles with full bodies; the equivalent grep path requires opening 8 files individually (thousands of tokens and multiple tool turns).
2. **Exact-string queries → `grep`.** Q2 is `grep`'s sweet spot. The CLI ships its own source of truth in `src/cli/`; semantic search ranks higher-level narrative articles above that.
3. **Q2 exposed a corpus gap, not a Monsthera limit.** `work close` shipped in release alpha.6 minutes before the observation was taken; no knowledge article described it yet. The sibling knowledge article `k-b577ihrv` ("Monsthera CLI Command Cheatsheet") now fills this gap — a follow-up observation in the next session should re-run Q2 with the cheatsheet indexed and confirm that `search` / `pack` now surface the correct syntax.
4. **Token accounting was missing.** Wall-clock latency is the least interesting axis for agents. The relevant cost is total conversation tokens through to a usable answer. The `k-pwksnl38` plan explicitly measures this; this observational note does not.

## Recommendations for the formal benchmark (updates to `k-pwksnl38`)

- Add a "retrieval quality" arm covering the five paths above (grep, search, get_article, pack, pack+content), on a mixed corpus of narrative queries and exact-string queries.
- Measure **turns to useful answer** and **total input + output tokens through turn N**, not just wall-clock latency.
- Deliberately include queries that target new CLI surface within the past 48 hours, so the "corpus freshness" failure mode is measured explicitly instead of left as an assumption.
- Deliberately include queries that have no semantic match (e.g. exact error strings, regex-like patterns), so the grep-wins region is measured rather than assumed.

## Decision: keep this as a note, not a result

Cancelling the spike at `enrichment → done` (skip-guard) because:

- The formal benchmark (`k-pwksnl38`, `w-uvp3azdf`) is the right vehicle for actual numbers; this note is observational scaffolding, not a substitute.
- Shipping this as an auditable observation keeps the session's data point recoverable for the future runner of the formal A/B without pretending it's a benchmark in its own right.

The research-note half of this closure is `k-b577ihrv`, which fills the corpus-freshness gap the observation exposed in Q2. Future sessions running the formal benchmark should re-measure Q2 against the cheatsheet and fold the delta into the final report.

## Links

- `k-pwksnl38` — Benchmark Methodology — Environment Snapshot + build_context_pack Impact (the formal playbook this note is scaffolding for).
- `k-b577ihrv` — Monsthera CLI Command Cheatsheet (the fix for the corpus gap Q2 exposed).
- `k-to46fuoi` — IRIS Meta-Harness research note (indexes the whole follow-up series).
- `w-uvp3azdf` — cancelled spike that captured the formal benchmark plan; this note is observational data the formal run should consume.
